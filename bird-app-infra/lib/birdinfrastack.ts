import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';

// Configuration constants
const MAX_AZS = 2;
const NAT_GATEWAYS = 1;
const INSTANCE_TYPE = ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM);

export class BirdInfraStack extends cdk.Stack {
  private k3sMaster: ec2.Instance;
  private securityGroup: ec2.SecurityGroup;
  private privateKey: secretsmanager.Secret;
  private keyPairSecretAttachment: KeyPairSecretAttachment;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'BirdAppVPC', {
      maxAzs: MAX_AZS,
      natGateways: NAT_GATEWAYS,
    });

    this.securityGroup = this.createInitialSecurityGroup(vpc);

    const key = new ec2.CfnKeyPair(this, 'K3sKeyPair', {
      keyName: 'k3s-key-pair',
    });

    this.privateKey = new secretsmanager.Secret(this, 'K3sPrivateKey', {
      secretName: 'k3s-private-key',
      description: 'Private key for K3s EC2 instances',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ privateKey: '' }),
        generateStringKey: 'privateKey'
      }
    });

    // Create the KeyPairSecretAttachment early
    this.keyPairSecretAttachment = new KeyPairSecretAttachment(this, 'KeyPairSecretAttachment', key.attrKeyPairId, this.privateKey.secretArn);

    // Reference existing hosted zone
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: 'vmlvaske.com',
    });

    // Reference existing ACM certificate
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate',
      'arn:aws:acm:eu-central-1:695321653301:certificate/28603096-5aef-48bd-8528-5313ac20cb89');

    const argocdLb = this.createArgocdLoadBalancer(vpc, this.k3sMaster, certificate as acm.Certificate);

    new route53.ARecord(this, 'ArgocdDNS', {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(argocdLb)),
      recordName: 'argocd.vmlvaske.com', // Replace with your desired subdomain
    });
    // Make other resources depend on the KeyPairSecretAttachment
    const masterRole = this.createMasterRole();
    masterRole.node.addDependency(this.keyPairSecretAttachment);

    const workerRole = this.createWorkerRole();
    workerRole.node.addDependency(this.keyPairSecretAttachment);

    const masterUserData = this.createMasterUserData();
    this.k3sMaster = this.createEC2Instance('K3sMaster', vpc, this.securityGroup, masterRole, masterUserData, key.keyName);
    this.k3sMaster.node.addDependency(this.keyPairSecretAttachment);

    const workerCount = new cdk.CfnParameter(this, 'WorkerCount', {
      type: 'Number',
      default: 2,
      minValue: 1,
    });

    for (let i = 0; i < workerCount.valueAsNumber; i++) {
      const workerUserData = this.createWorkerUserData(this.k3sMaster);
      this.createEC2Instance(`K3sWorker${i + 1}`, vpc, this.securityGroup, workerRole, workerUserData, key.keyName).node.addDependency(this.keyPairSecretAttachment);
    }

    // Update security group to allow traffic from ALB
    this.updateSecurityGroupForAlb(argocdLb);

    this.createOutputs(this.k3sMaster, argocdLb);
  }

  private createInitialSecurityGroup(vpc: ec2.Vpc): ec2.SecurityGroup {
    const securityGroup = new ec2.SecurityGroup(this, 'BirdAppSecurityGroup', {
      vpc,
      description: "Allow ssh, Kubernetes API Server, and ArgoCD access",
      allowAllOutbound: true,
    });

    this.addSecurityGroupRules(securityGroup);

    return securityGroup;
  }

  private addSecurityGroupRules(securityGroup: ec2.SecurityGroup): void {
    const ingressRules = [
      { port: 22, description: 'Allow SSH access from anywhere' },
      { port: 6443, description: 'Allow Kubernetes API Server' },
      { port: 8472, description: 'Allow k3s agent communication', protocol: ec2.Protocol.UDP },
      { port: 10250, description: 'Allow kubelet' },
      { port: 8080, description: 'Allow ArgoCD' },
    ];

    ingressRules.forEach(rule => {
      securityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        rule.protocol ? ec2.Port.udp(rule.port) : ec2.Port.tcp(rule.port),
        rule.description
      );
    });
  }

  private updateSecurityGroupForAlb(alb: elbv2.ApplicationLoadBalancer): void {
    // Allow ArgoCD UI access only from the ALB
    if (alb.connections.securityGroups && alb.connections.securityGroups.length > 0) {
      const albSecurityGroup = alb.connections.securityGroups[0];
      this.securityGroup.addIngressRule(
        ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),
        ec2.Port.tcp(8080),
        'Allow ArgoCD UI access from ALB'
      );
    } else {
      throw new Error('ALB security group not found');
    }
  }

  private createMasterRole(): iam.Role {
    const role = new iam.Role(this, 'MasterEC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'),
      ],
    });

    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter', 'ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/k3s/*`],
    }));

    const secretsManagerPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [this.privateKey.secretArn],
    });

    role.addToPolicy(secretsManagerPolicy);

    return role;
  }

  private createWorkerRole(): iam.Role {
    const role = new iam.Role(this, 'WorkerEC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'),
      ],
    });

    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/k3s/*`],
    }));

    const secretsManagerPolicy = new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [this.privateKey.secretArn],
    });

    role.addToPolicy(secretsManagerPolicy);

    return role;
  }

  private getUbuntuAMI(): ec2.IMachineImage {
    return ec2.MachineImage.fromSsmParameter(
      '/aws/service/canonical/ubuntu/server/20.04/stable/current/amd64/hvm/ebs-gp2/ami-id',
      { os: ec2.OperatingSystemType.LINUX }
    );
  }

  private createEC2Instance(id: string,
    vpc: ec2.Vpc,
    securityGroup: ec2.SecurityGroup,
    role: iam.Role,
    userData: ec2.UserData,
    keyName: string
  ): ec2.Instance {
    const instance = new ec2.Instance(this, id, {
      vpc,
      instanceType: INSTANCE_TYPE,
      machineImage: this.getUbuntuAMI(),
      securityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      role,
      userData,
      keyName,
    });

    // Add mutable properties separately
    cdk.Tags.of(instance).add('Environment', 'Production');

    return instance;
  }

  private createMasterUserData(): ec2.UserData {
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1',

      // Install AWS CLI
      'echo "Installing AWS CLI"',
      'apt-get update && apt-get install -y awscli',
      'source ~/.bashrc',

      // Set AWS region
      `echo "export AWS_DEFAULT_REGION=${this.region}" >> /etc/environment`,
      'source /etc/environment',

      // K3s installation
      'echo "Starting k3s installation"',
      'curl -sfL https://get.k3s.io | sh -',
      'echo "K3s installed, now storing the node token"',
      'TOKEN=$(cat /var/lib/rancher/k3s/server/node-token)',
      'aws ssm put-parameter --name "/k3s/node-token" --type "SecureString" --value "$TOKEN" --overwrite',
      'echo "Node token stored in SSM Parameter Store"',
      'echo "k3s installation completed"',
      'sleep 30',

      // Retrieve and store the token
      'TOKEN=$(sudo cat /var/lib/rancher/k3s/server/node-token)',
      'echo "Retrieved token: $TOKEN"',
      `aws ssm put-parameter --name "/k3s/node-token" --type "SecureString" --value "$TOKEN" --overwrite --region ${this.region}`,
      'if [ $? -eq 0 ]; then',
      '  echo "Node token successfully stored in SSM Parameter Store"',
      'else',
      '  echo "Failed to store node token in SSM Parameter Store"',
      '  aws sts get-caller-identity',
      '  exit 1',
      'fi',

      // Set up kubectl
      '/usr/local/bin/kubectl get nodes',
      'echo "K3s installation and node check completed"',
      'echo "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml" >> /home/ubuntu/.bashrc',
      'cp /etc/rancher/k3s/k3s.yaml /home/ubuntu/kubeconfig',
      'chown ubuntu:ubuntu /home/ubuntu/kubeconfig',
      'echo "export KUBECONFIG=/home/ubuntu/kubeconfig" >> /home/ubuntu/.bashrc',

      // Install ArgoCD
      'kubectl create namespace argocd',
      'kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml',
      'kubectl -n argocd patch deployment argocd-server --patch \'{"spec": {"template": {"spec": {"containers": [{"name": "argocd-server","command": ["argocd-server","--insecure"]}]}}}}\'',

      // Wait for ArgoCD to be ready
      'kubectl wait --for=condition=available --timeout=600s deployment/argocd-server -n argocd',

      // Apply the ArgoCD application
      'cat <<EOF | kubectl apply -f -',
      'apiVersion: argoproj.io/v1alpha1',
      'kind: Application',
      'metadata:',
      '  name: bird-app',
      '  namespace: argocd',
      'spec:',
      '  project: default',
      '  source:',
      '    repoURL: git@github.com:VMLVaske/devops-challenge.git',
      '    targetRevision: HEAD',
      '    path: helm',
      '    helm:',
      '      valueFiles:',
      '        - values.yaml',
      '  destination:',
      '    server: https://kubernetes.default.svc',
      '    namespace: default',
      '  syncPolicy:',
      '    automated:',
      '      prune: true',
      '      selfHeal: true',
      'EOF',

      // Get admin password
      'echo "ArgoCD admin password:"',
      'kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d'
    );
    return userData;
  }

  private createWorkerUserData(masterInstance: ec2.Instance): ec2.UserData {
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1',
      'until ping -c1 amazon.com &>/dev/null; do echo "Waiting for network..."; sleep 1; done',
      'echo "Installing AWS CLI and other tools"',
      'apt-get update && apt-get install -y awscli jq',
      'echo "export AWS_DEFAULT_REGION=eu-central-1" >> /etc/environment',
      'source /etc/environment',
      'echo "Starting k3s agent installation"',
      `K3S_URL="https://${masterInstance.instancePrivateIp}:6443"`,
      'for attempt in {1..10}; do',
      '  echo "Attempt $attempt to retrieve token and install k3s agent"',
      '  TOKEN=$(aws ssm get-parameter --name "/k3s/node-token" --with-decryption --query Parameter.Value --output text --region ${AWS_DEFAULT_REGION} 2>&1)',
      '  if [ $? -eq 0 ] && [ ! -z "$TOKEN" ]; then',
      '    echo "Token retrieved successfully"',
      '    INSTALL_K3S_EXEC="agent --server $K3S_URL --token $TOKEN" curl -sfL https://get.k3s.io | sh -',
      '    if [ $? -eq 0 ]; then',
      '      echo "k3s agent installed successfully"',
      '      break',
      '    else',
      '      echo "k3s agent installation failed, will retry..."',
      '    fi',
      '  else',
      '    echo "Failed to retrieve token, will retry..."',
      '  fi',
      '  sleep 30',
      'done',
      'if ! systemctl is-active --quiet k3s-agent; then',
      '  echo "k3s-agent failed to start after multiple attempts. Checking logs:"',
      '  journalctl -u k3s-agent --no-pager',
      '  exit 1',
      'fi',
      'echo "k3s agent installation completed successfully"'
    );
    return userData;
  }

  private createOutputs(k3sMaster: ec2.Instance, argocdLb: elbv2.ApplicationLoadBalancer): void {
    new cdk.CfnOutput(this, 'K3sMasterPublicIp', {
      value: k3sMaster.instancePublicIp,
      description: 'Public IP address of the k3s master node',
      exportName: 'MasterNodePublicIP'
    });

    new cdk.CfnOutput(this, 'ArgoCDLoadBalancerDNS', {
      value: argocdLb.loadBalancerDnsName,
      description: 'DNS name of the ArgoCD load balancer'
    });
  }

  private createArgocdLoadBalancer(vpc: ec2.Vpc, k3sMaster: ec2.Instance, certificate: acm.Certificate): elbv2.ApplicationLoadBalancer {
    const lb = new elbv2.ApplicationLoadBalancer(this, 'ArgocdLoadBalancer', {
      vpc,
      internetFacing: true
    });

    const listener = lb.addListener('ArgoListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
    });

    listener.addTargets('ArgoTargets', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new targets.IpTarget('10.0.0.1'), new targets.IpTarget('10.0.0.2')], // Replace with your actual target IPs
      healthCheck: {
        path: '/',
        protocol: elbv2.Protocol.HTTP
      }
    });

    listener.addTargets('ArgoHealthTargets', {
      port: 8080, // ArgoCD server typically runs on 8080
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new targets.InstanceTarget(this.k3sMaster)],
      healthCheck: {
        path: '/healthz',
        protocol: elbv2.Protocol.HTTP
      }
    });

    // Allow inbound traffic from the load balancer to the k3s master
    k3sMaster.connections.allowFrom(lb, ec2.Port.tcp(8080));

    return lb;
  }
}

class KeyPairSecretAttachmentProvider extends Construct {
  public readonly serviceToken: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const onEventHandler = new lambdaNodejs.NodejsFunction(this, 'KeyPairSecretAttachmentHandler', {
      entry: path.join(__dirname, 'lambda', 'index.js'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2020',
        externalModules: ['aws-sdk'],
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      initialPolicy: [
        new iam.PolicyStatement({
          actions: [
            'ec2:DescribeKeyPairs',
            'secretsmanager:PutSecretValue'
          ],
          resources: ['*'],
        }),
      ],
    });

    const provider = new cdk.custom_resources.Provider(this, 'Provider', {
      onEventHandler,
    });

    this.serviceToken = provider.serviceToken;
  }
}

class KeyPairSecretAttachment extends Construct {
  public readonly customResource: cdk.CustomResource;

  constructor(scope: Construct, id: string, keyPairId: string, secretId: string) {
    super(scope, id);

    const provider = new KeyPairSecretAttachmentProvider(this, 'Provider');

    this.customResource = new cdk.CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        KeyPairId: keyPairId,
        SecretId: secretId,
      },
    });
  }
}