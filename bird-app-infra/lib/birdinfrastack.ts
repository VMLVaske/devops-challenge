import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class BirdInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'BirdAppVPC', {
      maxAzs: 2,
      natGateways: 1,
    });

    const securityGroup = new ec2.SecurityGroup(this, 'BirdAppSecurityGroup', {
      vpc,
      description: "Allow ssh (TCP port 22) and Kubernetes API Server (TCP port 6443) in.",
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow SSH access from anywhere'
    );

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(6443),
      'Allow Kubernetes API Server access'
    )

    // create IAM role for the EC2 instance
    const role = new iam.Role(this, 'BirdAppEC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    // Use Ubuntu AMI instead of Amazon Linux 2
    const machineImage = ec2.MachineImage.fromSsmParameter(
      '/aws/service/canonical/ubuntu/server/20.04/stable/current/amd64/hvm/ebs-gp2/ami-id',
      { os: ec2.OperatingSystemType.LINUX }
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1',
      'echo "Starting k3s installation"',
      'curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -',
      'echo "k3s installation completed"',
      '/usr/local/bin/kubectl get nodes',
      'echo "K3s installation and node check completed"',
      'echo "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml" >> /home/ubuntu/.bashrc',
      'cp /etc/rancher/k3s/k3s.yaml /home/ubuntu/kubeconfig',
      'chown ubuntu:ubuntu /home/ubuntu/kubeconfig',
      'echo "export KUBECONFIG=/home/ubuntu/kubeconfig" >> /home/ubuntu/.bashrc'
    )

    // Create EC2 Instance
    const instanceType = ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM);

    const k3sMaster = new ec2.Instance(this, 'K3sMaster', {
      vpc,
      instanceType,
      machineImage,
      securityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      role,
      userData,
    });

    new cdk.CfnOutput(this, 'K3sMasterPublicIp', {
      value: k3sMaster.instancePublicIp,
      description: 'Public IP address of the k3s master node',
    })

    // create worker nodes

    for (let i = 0; i < 2; i++) {
      const workerUserData = ec2.UserData.forLinux();
      workerUserData.addCommands(
        `curl -sfL https://get.k3s.io | K3S_URL=https://${k3sMaster.instancePrivateIp}:6443 K3S_TOKEN=$(ssh -i /path/to/your/key.pem ec2-user@${k3sMaster.instancePrivateIp} 'sudo cat /var/lib/rancher/k3s/server/node-token') sh -`
      );

      new ec2.Instance(this, `K3sWorker${i + 1}`, {
        vpc,
        instanceType,
        machineImage,
        securityGroup,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        role,
        userData: workerUserData,
      })
    }

  }
}
