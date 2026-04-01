#!/bin/bash
set -euo pipefail

# Full cluster setup: Traefik + Argo CD + Argo Workflows + Argo Events + Docker Registry
#
# Run:     ./cluster/setup.sh
# Prereqs: kubectl (connected to cluster), helm
# Idempotent: safe to re-run (helm upgrade --install, kubectl apply)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Adding Helm repos ==="
helm repo add traefik https://traefik.github.io/charts
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

# --- 1. Traefik (replaces nginx ingress controller) ---
echo ""
echo "=== 1/5 Installing Traefik ==="
kubectl create namespace traefik --dry-run=client -o yaml | kubectl apply -f -

# Install Traefik CRDs manually (skip gateway-standard-install.yaml which conflicts with DOKS)
TRAEFIK_CRDS=$(helm pull traefik/traefik --version 39.0.7 --untar --untardir /tmp/traefik-crds 2>/dev/null && echo /tmp/traefik-crds/traefik/crds)
for f in "$TRAEFIK_CRDS"/traefik.io_*.yaml "$TRAEFIK_CRDS"/hub.traefik.io_*.yaml; do
  kubectl apply -f "$f"
done

helm upgrade --install traefik traefik/traefik \
  --namespace traefik \
  --version 39.0.7 \
  --values "$SCRIPT_DIR/traefik/values.yaml" \
  --skip-crds \
  --wait

echo "Traefik LoadBalancer IP:"
kubectl -n traefik get svc traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "(pending)"
echo ""

# --- 2. Argo CD ---
echo ""
echo "=== 2/5 Installing Argo CD ==="
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd \
  --version 9.4.17 \
  --values "$SCRIPT_DIR/argocd/values.yaml" \
  --wait
kubectl apply -f "$SCRIPT_DIR/argocd/ingressroute.yaml"

echo "Argo CD initial admin password:"
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" 2>/dev/null | base64 -d || echo "(not yet available)"
echo ""

# --- 3. Argo Workflows ---
echo ""
echo "=== 3/5 Installing Argo Workflows ==="
kubectl create namespace argo --dry-run=client -o yaml | kubectl apply -f -
helm upgrade --install argo-workflows argo/argo-workflows \
  --namespace argo \
  --version 1.0.6 \
  --values "$SCRIPT_DIR/argo-workflows/values.yaml" \
  --wait
kubectl apply -f "$SCRIPT_DIR/argo-workflows/ingressroute.yaml"

# --- 4. Argo Events ---
echo ""
echo "=== 4/5 Installing Argo Events ==="
helm upgrade --install argo-events argo/argo-events \
  --namespace argo \
  --version 2.4.21 \
  --values "$SCRIPT_DIR/argo-events/values.yaml" \
  --wait

# --- 5. Docker Registry ---
echo ""
echo "=== 5/5 Installing Docker Registry ==="
kubectl apply -f "$SCRIPT_DIR/registry/deployment.yaml"
kubectl -n registry rollout status deployment/registry --timeout=60s

# --- Done ---
echo ""
echo "=== Setup complete ==="
echo ""
echo "Endpoints (need DNS records → Traefik LB IP):"
echo "  Traefik dashboard: https://traefik.mfe.fachwerk.dev"
echo "  Argo CD:           https://argocd.mfe.fachwerk.dev  (user: admin)"
echo "  Argo Workflows:    https://argo.mfe.fachwerk.dev"
echo "  Docker registry:   https://registry.mfe.fachwerk.dev"
echo ""
echo "In-cluster registry: registry.registry.svc.cluster.local:5000"
echo ""
echo "Next steps:"
echo "  1. Point DNS *.mfe.fachwerk.dev → Traefik LB IP (above)"
echo "  2. Create DO token secret for TLS:"
echo "     kubectl -n traefik create secret generic digitalocean-dns --from-literal=token=YOUR_DO_TOKEN"
echo "  3. Create GitHub token secret for Argo Events:"
echo "     kubectl -n argo create secret generic github-token --from-literal=token=YOUR_GITHUB_TOKEN"
echo ""
echo "To remove old nginx ingress + cert-manager (after verifying Traefik works):"
echo "  kubectl delete namespace ingress-nginx"
echo "  kubectl delete namespace cert-manager"
