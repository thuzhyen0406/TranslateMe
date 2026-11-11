#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

labels=(
  "test/tv1-harness-and-suites|harness-and-suites"
  "task/tv1-demo-deploy-and-preflight|demo-deploy-and-preflight"
  "task/tv1-evidence-report-and-ci|evidence-report-and-ci"
)

printf '%-42s %s\n' 'Branch nhiệm vụ' 'Trạng thái local'
printf '%-42s %s\n' '----------------' '---------------'
for label in "${labels[@]}"; do
  IFS='|' read -r planned alias <<< "$label"
  if git show-ref --verify --quiet "refs/heads/$planned"; then
    status="$planned (tên theo nhiệm vụ)"
    checkout="$planned"
  elif git show-ref --verify --quiet "refs/heads/$alias"; then
    status="$alias (tên branch trong repo)"
    checkout="$alias"
  else
    status='chưa có local'
    checkout="$planned"
  fi
  printf '%-42s %s\n' "$planned" "$status"
  printf '  git switch %s\n' "$checkout"
done

printf '\nDependency PR: nhánh 1 → nhánh 2 → nhánh 3. Script chỉ đọc trạng thái; không sửa Git refs.\n'
