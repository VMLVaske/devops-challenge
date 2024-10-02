import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

// Configuration constants
const MAX_AZS = 2;
const NAT_GATEWAYS = 1;
const WORKER_COUNT = 2;
const INSTANCE_TYPE = ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM);


export class BirdInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'BirdAppVPC', {
      maxAzs: MAX_AZS,
      natGateways: NAT_GATEWAYS,
    });

    const securityGroup = this.createSecurityGroup(vpc);
    const masterRole = this.createMasterRole();
    const workerRole = this.createWorkerRole();
    const machineImage = this.getUbuntuAMI();
    const bucket = this.createConfigBucket();

    const masterUserData = this.createMasterUserData(bucket);
    const k3sMaster = this.createEC2Instance('K3sMaster', vpc, securityGroup, masterRole, masterUserData);

    for (let i = 0; i < WORKER_COUNT; i++) {
      const workerUserData = this.createWorkerUserData(k3sMaster);
      this.createEC2Instance(`K3sWorker${i + 1}`, vpc, securityGroup, workerRole, workerUserData);
    }

    this.createOutputs(k3sMaster, bucket);
  }

  private createSecurityGroup(vpc: ec2.Vpc): ec2.SecurityGroup {
    const securityGroup = new ec2.SecurityGroup(this, 'BirdAppSecurityGroup', {
      vpc,
      description: "Allow ssh and Kubernetes API Server access",
      allowAllOutbound: true,
    });

    const ingressRules = [
      { port: 22, description: 'Allow SSH access from anywhere' },
      { port: 6443, description: 'Allow Kubernetes API Server' },
      { port: 8472, description: 'Allow k3s agent communication', protocol: ec2.Protocol.UDP },
      { port: 10250, description: 'Allow kubelet' },
    ];

    ingressRules.forEach(rule => {
      securityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        rule.protocol ? ec2.Port.udp(rule.port) : ec2.Port.tcp(rule.port),
        rule.description
      );
    });

    return securityGroup;
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

    return role;
  }

  private getUbuntuAMI(): ec2.IMachineImage {
    return ec2.MachineImage.fromSsmParameter(
      '/aws/service/canonical/ubuntu/server/20.04/stable/current/amd64/hvm/ebs-gp2/ami-id',
      { os: ec2.OperatingSystemType.LINUX }
    );
  }

  private createConfigBucket(): s3.Bucket {
    const bucket = new s3.Bucket(this, 'BirdAppConfigBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    return bucket;
  }

  private createEC2Instance(id: string,
    vpc: ec2.Vpc,
    securityGroup: ec2.SecurityGroup,
    role: iam.Role,
    userData: ec2.UserData
  ): ec2.Instance {
    return new ec2.Instance(this, id, {
      vpc,
      instanceType: INSTANCE_TYPE,
      machineImage: this.getUbuntuAMI(),
      securityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      role,
      userData,
      userDataCausesReplacement: true,
    });
  }

  private createMasterUserData(bucket: s3.Bucket): ec2.UserData {
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1',

      // Install AWS CLI first
      'echo "Installing AWS CLI"',
      'apt-get update && apt-get install -y awscli',
      'source ~/.bashrc',  // This refreshes the PATH to include AWS CLI

      // Set AWS region
      `echo "export AWS_DEFAULT_REGION=${this.region}" >> /etc/environment`,
      'source /etc/environment',

      // K3s installation
      'echo "Starting k3s installation"',
      'curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -',
      'echo "k3s installation completed"',
      'sleep 30', // Give k3s more time to generate the token

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

      // Rest of your commands
      '/usr/local/bin/kubectl get nodes',
      'echo "K3s installation and node check completed"',
      'echo "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml" >> /home/ubuntu/.bashrc',
      'cp /etc/rancher/k3s/k3s.yaml /home/ubuntu/kubeconfig',
      'chown ubuntu:ubuntu /home/ubuntu/kubeconfig',
      'echo "export KUBECONFIG=/home/ubuntu/kubeconfig" >> /home/ubuntu/.bashrc',

      // S3 Commands
      'echo "Downloading Kubernetes manifests from S3"',
      `aws s3 cp s3://${bucket.bucketName}/bird-api.yaml /home/ubuntu/bird-api.yaml`,
      `aws s3 cp s3://${bucket.bucketName}/birdimage-api.yaml /home/ubuntu/birdimage-api.yaml`,
      'chown ubuntu:ubuntu /home/ubuntu/*.yaml',
      'echo "Kubernetes manifests downloaded successfully"'

    );
    return userData;
  }

  private createWorkerUserData(k3sMaster: ec2.Instance): ec2.UserData {
    const userData = ec2.UserData.forLinux();
    userData.addCommands('#!/bin/bash',
      'exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1',

      // Wait for network to be ready
      'until ping -c1 amazon.com &>/dev/null; do echo "Waiting for network..."; sleep 1; done',

      // Install AWS CLI and other necessary tools
      'echo "Installing AWS CLI and other tools"',
      'apt-get update && apt-get install -y awscli jq',
      'source ~/.bashrc',

      // Set AWS region
      `echo "export AWS_DEFAULT_REGION=${this.region}" >> /etc/environment`,
      'source /etc/environment',

      // Start k3s agent installation
      'echo "Starting k3s agent installation"',
      `K3S_URL="https://${k3sMaster.instancePrivateIp}:6443"`,

      // Retry logic for token retrieval and k3s agent installation
      'for attempt in {1..10}; do',
      '  echo "Attempt $attempt to retrieve token and install k3s agent"',
      '  TOKEN=$(aws ssm get-parameter --name "/k3s/node-token" --with-decryption --query Parameter.Value --output text --region ${this.region} 2>&1)',
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

      // Check if installation was successful
      'if ! systemctl is-active --quiet k3s-agent; then',
      '  echo "k3s-agent failed to start after multiple attempts. Checking logs:"',
      '  journalctl -u k3s-agent --no-pager',
      '  exit 1',
      'fi',

      'echo "k3s agent installation completed successfully"',
      'systemctl status k3s-agent',);
    return userData;
  }

  private createOutputs(k3sMaster: ec2.Instance, bucket: s3.Bucket): void {
    new cdk.CfnOutput(this, 'K3sMasterPublicIp', {
      value: k3sMaster.instancePublicIp,
      description: 'Public IP address of the k3s master node',
    });

    new cdk.CfnOutput(this, 'ConfigBucketName', {
      value: bucket.bucketName,
      description: 'S3 bucket for storing Kubernetes configuration'
    });
  }
}