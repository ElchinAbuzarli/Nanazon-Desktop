#!/bin/bash
# Auto-bump version based on commit messages since last tag
# Usage: ./scripts/bump-version.sh [--dry-run]
#
# Commit message conventions:
#   feat!: or BREAKING CHANGE: → major (2.0.0 → 3.0.0)
#   feat:                      → minor (2.0.0 → 2.1.0)
#   fix: / chore: / etc        → patch (2.0.0 → 2.0.1)

set -e
cd "$(dirname "$0")/.."

DRY_RUN=""
[[ "$1" == "--dry-run" ]] && DRY_RUN=1

# Get current version from package.json
CURRENT=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT"

# Parse current version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

# Get commits since last tag (or all if no tags)
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
  COMMITS=$(git log "$LAST_TAG"..HEAD --pretty=format:"%s" 2>/dev/null)
else
  COMMITS=$(git log --pretty=format:"%s" -20 2>/dev/null)
fi

if [ -z "$COMMITS" ]; then
  echo "No new commits since last tag. Version unchanged."
  exit 0
fi

# Determine bump type
BUMP="patch"
while IFS= read -r msg; do
  # Check for breaking change (major)
  if echo "$msg" | grep -qiE "^(feat|fix|chore|refactor|perf)!:|BREAKING CHANGE"; then
    BUMP="major"
    break
  fi
  # Check for feature (minor)
  if echo "$msg" | grep -qiE "^feat(\(.*\))?:"; then
    [ "$BUMP" != "major" ] && BUMP="minor"
  fi
done <<< "$COMMITS"

# Calculate new version
case "$BUMP" in
  major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
  patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
esac

echo "Bump type: $BUMP"
echo "New version: $NEW_VERSION"

if [ -n "$DRY_RUN" ]; then
  echo "(dry run - no files changed)"
  exit 0
fi

# Update all version files
# package.json
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# tauri.conf.json
node -e "
const fs = require('fs');
const conf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8'));
conf.version = '$NEW_VERSION';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(conf, null, 2) + '\n');
"

# Cargo.toml
sed -i '' "s/^version = \".*\"/version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml

echo "Updated to $NEW_VERSION in package.json, tauri.conf.json, Cargo.toml"
echo ""
echo "To tag: git tag v$NEW_VERSION"
