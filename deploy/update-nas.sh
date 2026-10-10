#!/bin/sh
# Run manually on the NAS. No SSH, registry password or live database access.
set -eu
umask 077

usage() {
  echo 'Usage: sh update-nas.sh VERSION [PROJECT_DIRECTORY]'
  echo 'VERSION: 0.2.0, a prerelease version, or sha- followed by a full commit hash.'
}
fail() { echo "ERROR: $*" >&2; exit 1; }
[ "${1:-}" != '--help' ] || { usage; exit 0; }
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { usage; exit 1; }
version=$1
printf '%s\n' "$version" | grep -Eq '^([0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?|sha-[a-f0-9]{40})$' || fail 'Choose a fixed release version or full commit tag; edge/latest are not installation versions.'
project=$(cd "${2:-/volume1/docker/orbit}" && pwd -P)
cd "$project"
env_file="$project/.env"
compose_file="$project/compose.synology.yml"
lock="$project/.orbit-update.lock"
timeout=${HEALTH_TIMEOUT:-180}
case "$timeout" in ''|*[!0-9]*) fail 'HEALTH_TIMEOUT must be seconds as an integer.' ;; esac
[ -f "$env_file" ] && [ ! -L "$env_file" ] || fail 'Create a regular .env file in the project directory.'
[ -f "$compose_file" ] || fail 'Missing compose.synology.yml.'
grep -q 'ORBIT_IMAGE' "$compose_file" || fail 'Copy the registry-enabled compose.synology.yml into the project first.'
for command in docker tar gzip sha256sum awk df du mktemp; do
  command -v "$command" >/dev/null 2>&1 || fail "Missing command: $command"
done
if docker compose version >/dev/null 2>&1; then
  compose() { docker compose --env-file "$env_file" -f "$compose_file" "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose --env-file "$env_file" -f "$compose_file" "$@"; }
else
  fail 'Docker Compose is unavailable. Install/start Container Manager.'
fi
mkdir "$lock" 2>/dev/null || fail 'Another update holds .orbit-update.lock. Check its process before removing a stale lock.'
echo "$$" > "$lock/pid"
stopped=0
deployment_started=0
new_container=''
temp_env=''
backup=''
cleanup() {
  status=$?
  trap - 0
  if [ "$status" -ne 0 ]; then
    if [ "$stopped" -eq 1 ] && [ "$deployment_started" -eq 0 ]; then
      echo 'Update failed before deployment; restarting the original container.' >&2
      docker start "$old_container" >/dev/null || echo 'Could not restart the original container; inspect it in Container Manager.' >&2
    elif [ "$deployment_started" -eq 1 ]; then
      [ -n "$new_container" ] || new_container=$(compose ps -a -q orbit 2>/dev/null || true)
      if [ -n "$new_container" ]; then
        docker stop --time 150 "$new_container" >/dev/null 2>&1 || true
      fi
      echo 'Deployment failed. The new container is stopped; no automatic data/image rollback was attempted.' >&2
      echo "Inspect the logs and use the retained backup if a migration prevents rollback: $backup" >&2
    fi
  fi
  [ -z "$temp_env" ] || rm -f "$temp_env"
  rm -f "$lock/pid"
  rmdir "$lock" || true
  exit "$status"
}
trap cleanup 0
trap 'exit 130' INT TERM HUP

old_container=$(compose ps -a -q orbit)
printf '%s\n' "$old_container" | grep -Eq '^[a-f0-9]{12,64}$' || fail 'Exactly one existing Orbit container is required. For the initial installation, start the project first.'
[ "$(docker inspect --format '{{.State.Running}}' "$old_container")" = true ] || fail 'Start the existing Orbit container before using the updater.'
mount_source() {
  docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" "$1"
}
[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}{{end}}{{end}}' "$old_container")" = bind ] || fail 'The updater requires the NAS data bind mount from the deployment guide.'
data_path=$(cd "$(mount_source "$old_container" /data)" && pwd -P)
password_file=$(mount_source "$old_container" /run/secrets/owner-password.json)
[ -f "$password_file" ] || fail 'The mounted owner password hash file is missing.'
for running in $(docker ps -q); do
  if [ "$running" != "$old_container" ] && [ "$(mount_source "$running" /data)" = "$data_path" ]; then
    fail 'Another running container shares the Orbit data folder. Stop that instance first.'
  fi
done
old_image=$(docker inspect --format '{{.Image}}' "$old_container")
old_reference=$(docker inspect --format '{{.Config.Image}}' "$old_container")
requested="ghcr.io/mattz1337/orbit:$version"
echo "Downloading $requested before stopping Orbit…"
docker pull "$requested"
[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$requested")" = linux/amd64 ] || fail 'The selected image is not linux/amd64.'
target_image=$(docker image inspect --format '{{.Id}}' "$requested")
target_digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$requested" | awk '/^ghcr\.io\/mattz1337\/orbit@sha256:[a-f0-9]+$/ { print; exit }')
printf '%s\n' "$target_digest" | grep -Eq '^ghcr\.io/mattz1337/orbit@sha256:[a-f0-9]{64}$' || fail 'Cannot resolve a digest for the pulled image.'
ORBIT_IMAGE=$target_digest
export ORBIT_IMAGE
compose config --images | grep -Fx "$target_digest" >/dev/null || fail 'Compose does not use ORBIT_IMAGE. Install the updated Compose file.'
if [ "$old_image" = "$target_image" ]; then
  echo 'That exact image is already installed. No restart or backup is needed.'
  exit 0
fi
backup_root="$project/.orbit-backups"
mkdir -p "$backup_root"
backup_root=$(cd "$backup_root" && pwd -P)
case "$backup_root/" in "$data_path/"*) fail 'Backup directory must be outside the data mount.' ;; esac
chmod 700 "$backup_root"
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
backup="$backup_root/$stamp"
mkdir "$backup"
rollback_image="orbit-rollback:$stamp"
docker image tag "$old_image" "$rollback_image"
cp "$env_file" "$backup/project.env"
cp "$compose_file" "$backup/compose.synology.yml"
cp "$password_file" "$backup/owner-password.json"
printf 'previous_image=%s\nprevious_reference=%s\nrollback_image=%s\nrequested_image=%s\ntarget_digest=%s\ndata_path=%s\n' \
  "$old_image" "$old_reference" "$rollback_image" "$requested" "$target_digest" "$data_path" > "$backup/update.txt"

echo 'Stopping Orbit cleanly before copying its data…'
stopped=1
compose stop -t 150 orbit
[ "$(docker inspect --format '{{.State.Running}}' "$old_container")" = false ] || fail 'The original container is still running.'
[ "$(docker inspect --format '{{.State.ExitCode}}' "$old_container")" = 0 ] || fail 'Shutdown was not clean. Inspect the original container before retrying.'
needed=$(du -sk "$data_path" | awk '{print $1}')
available=$(df -Pk "$backup_root" | awk 'END {print $4}')
[ "$available" -gt "$((needed + 65536))" ] || fail 'Not enough free backup space for the full data folder plus 64 MB.'
tar -czf "$backup/data.tar.gz.partial" -C "$data_path" .
gzip -t "$backup/data.tar.gz.partial"
mv "$backup/data.tar.gz.partial" "$backup/data.tar.gz"
(cd "$backup" && sha256sum data.tar.gz > data.tar.gz.sha256)
echo "Stopped-data backup completed: $backup"

# Replace only the image entry; never execute/source the deployment .env file.
temp_env=$(mktemp "$env_file.update.XXXXXX")
awk '!/^[[:space:]]*(export[[:space:]]+)?ORBIT_IMAGE[[:space:]]*=/' "$env_file" > "$temp_env"
printf '\nORBIT_IMAGE=%s\n' "$target_digest" >> "$temp_env"
mv "$temp_env" "$env_file"
temp_env=''
deployment_started=1
# Create first, then verify mounts/image before any new application code runs.
compose up --no-start --no-deps --force-recreate orbit
new_container=$(compose ps -a -q orbit)
printf '%s\n' "$new_container" | grep -Eq '^[a-f0-9]{12,64}$' || fail 'Could not identify the new Orbit container.'
[ "$(docker inspect --format '{{.Image}}' "$new_container")" = "$target_image" ] || fail 'Compose created an unexpected image.'
[ "$(mount_source "$new_container" /data)" = "$data_path" ] || fail 'The new container would use a different data folder.'
[ "$(mount_source "$new_container" /run/secrets/owner-password.json)" = "$password_file" ] || fail 'The new container would use a different password file.'
compose start orbit
deadline=$(($(date +%s) + timeout))
while [ "$(date +%s)" -le "$deadline" ]; do
  running=$(docker inspect --format '{{.State.Running}}' "$new_container")
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$new_container")
  if [ "$running" = true ] && [ "$health" = healthy ]; then
    echo "SUCCESS: $requested is healthy. Installed digest: $target_digest"
    echo "Backup and previous image retained: $backup / $rollback_image"
    echo 'Sign in again and check model/job readiness in Settings/Sources.'
    exit 0
  fi
  [ "$running" = true ] && [ "$health" != unhealthy ] && [ "$health" != missing ] || fail "The new container is not healthy (running=$running, health=$health)."
  sleep 2
done
fail 'Timed out waiting for the new container health check.'
