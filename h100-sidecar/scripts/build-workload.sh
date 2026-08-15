#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <base-image@sha256:digest> <registry/repository:tag>" >&2
  exit 64
fi
base_image=$1
target_image=$2
case "$base_image" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "base image must be pinned by sha256 digest" >&2; exit 65 ;;
esac
command -v docker >/dev/null
command -v trivy >/dev/null
docker build --pull=false --build-arg "BASE_IMAGE=$base_image" --tag "$target_image" workload
trivy image --exit-code 1 --severity CRITICAL --ignore-unfixed=false "$target_image"
docker image inspect --format '{{.Id}}' "$target_image"
echo "Local build and CRITICAL vulnerability gate passed. Push only after review, then use its immutable RepoDigest." >&2
