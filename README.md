# Bird Application

This is the bird Application! It gives us birds!!!

The app is written in Golang and contains 2 APIs:
- the bird API
- the birdImage API

When you run the application (figure it out), you will see the relationship between those 2 APIs.

# Installation & How to run it

Make sure that you have go installed on your machine.

cd into the bird or birdImage directory and run `make`. This will download the dependencies and create the go binary. 
You can run the binary with `./bird` or `./birdImage`.

This reveals that birdApi depends on birdImageApi.

# Challenge

How to:
- fork the repository
- work on the challenges
- share your repository link with the recruitment team

Here are the challenges:
- Install and run the app
- Dockerize it (create dockerfile for each API)
- Create an infra on AWS (VPC, SG, instances) using IaC
- Install a small version of kubernetes on the instances (no EKS)
- Build the manifests to run the 2 APIs on k8s 
- Bonus points: observability, helm, scaling

Rules:
- Use security / container / k8s / cloud best practices
- Change in the source code is possible

Evaluation criterias:
- best practices
- code organization
- clarity & readability

# Solution: Bird Application Infrastructure

## Key Components

1. **Bird API & BirdImage API**: Two Golang APIs containerized with Docker
2. **AWS Infrastructure**: VPC, EC2 instances, security groups, and IAM roles created with AWS CDK
3. **Kubernetes Cluster**: k3s deployed on EC2 instances
4. **GitOps Deployment**: ArgoCD for automated, Git-based deployments
5. **CI/CD Pipeline**: GitHub Actions for continuous integration and delivery
6. **Helm Charts**: Used for packaging and deploying the application
7. **Dynamic EC2 Key Pair**: Automatically generated and securely stored in AWS Secrets Manager

## Getting Started

### Prerequisites

- Go 1.22 or later
- Docker
- AWS CLI and CDK v2
- kubectl
- Helm

### Running the APIs Locally

1. Navigate to either `apis/bird` or `apis/birdImage` directory
2. Run `make` to build the binary
3. Execute with `./bird` or `./birdImage`

Note: The Bird API depends on the BirdImage API.

### Containerization

Docker images are automatically built and pushed by the CI/CD pipeline. To build manually:

```bash
cd apis/bird
docker build -t your-dockerhub-username/bird-api:latest -f Dockerfile.bird-api .
docker push your-dockerhub-username/bird-api:latest
cd ../birdImage
docker build -t your-dockerhub-username/birdimage-api:latest -f Dockerfile.birdimage-api .
docker push your-dockerhub-username/birdimage-api:latest
```

### Deploying Infrastructure

1. Navigate to `bird-app-infra` directory
2. Run `npm install`
3. Build the CDK app with `npm run build`
4. Deploy with `npx cdk deploy`

## CI/CD Workflow

1. Push to the main branch triggers GitHub Actions
2. Actions build, test, and push new Docker images
3. Helm chart values are updated with new image tags
4. CDK stack is deployed/updated
5. ArgoCD detects changes and applies them to the cluster

## Kubernetes Deployment

Helm charts are located in the `helm` directory. ArgoCD automatically applies these to the cluster based on the configuration in `bird-app-infra/argocd/application.yaml`.

## Customization

Modify configuration constants in the CDK stack (`bird-app-infra/lib/birdinfrastack.ts`) or adjust Helm values (`helm/values.yaml`) as needed.

## Cleanup

Run `npx cdk destroy` in the `bird-app-infra` directory to remove all AWS resources.

## Notes

- Uses Ubuntu 20.04 LTS AMI for EC2 instances
- Implements security best practices for AWS and Kubernetes
- Demonstrates skills in IaC, containerization, GitOps, and Helm
- EC2 key pairs are dynamically generated and securely stored

## Evaluation Criteria

- Best practices in security, containerization, Kubernetes, and cloud
- Code organization and clarity
- Infrastructure scalability and maintainability

## ArgoCD Configuration

The ArgoCD application is defined in `bird-app-infra/argocd/application.yaml`. This configuration tells ArgoCD to deploy our application using the Helm chart located in the `helm` directory.

## Secrets Management

EC2 instance private keys are automatically generated and stored in AWS Secrets Manager. The GitHub Actions workflow retrieves these securely for SSH access during deployment.