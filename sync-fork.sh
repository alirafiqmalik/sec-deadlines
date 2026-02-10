#!/bin/bash

# Script to sync fork with upstream repository while preserving local commits
# Usage: ./sync-fork.sh [upstream-repo-url]

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default upstream URL
DEFAULT_UPSTREAM="https://github.com/sec-deadlines/sec-deadlines.github.io.git"
UPSTREAM_URL="${1:-$DEFAULT_UPSTREAM}"
UPSTREAM_NAME="upstream"

echo -e "${BLUE}=== Fork Sync Script ===${NC}\n"

# Check if we're in a git repository
if ! git rev-parse --is-inside-work-tree &> /dev/null; then
    echo -e "${RED}Error: Not in a git repository${NC}"
    exit 1
fi

# Get current branch
CURRENT_BRANCH=$(git branch --show-current)
echo -e "${BLUE}Current branch:${NC} $CURRENT_BRANCH"

# Check if working directory is clean
if ! git diff-index --quiet HEAD --; then
    echo -e "${RED}Error: Working directory has uncommitted changes${NC}"
    echo -e "${YELLOW}Please commit or stash your changes first${NC}"
    exit 1
fi

# Check if upstream remote exists
if git remote | grep -q "^${UPSTREAM_NAME}$"; then
    echo -e "${GREEN}✓${NC} Upstream remote '${UPSTREAM_NAME}' already exists"
    EXISTING_URL=$(git remote get-url $UPSTREAM_NAME)
    echo -e "  URL: $EXISTING_URL"
    
    # Ask if user wants to update the URL if it's different
    if [ "$EXISTING_URL" != "$UPSTREAM_URL" ]; then
        echo -e "${YELLOW}Warning: Existing upstream URL differs from provided URL${NC}"
        read -p "Update upstream URL to $UPSTREAM_URL? (y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            git remote set-url $UPSTREAM_NAME "$UPSTREAM_URL"
            echo -e "${GREEN}✓${NC} Updated upstream URL"
        fi
    fi
else
    echo -e "${BLUE}Adding upstream remote...${NC}"
    git remote add $UPSTREAM_NAME "$UPSTREAM_URL"
    echo -e "${GREEN}✓${NC} Added upstream remote: $UPSTREAM_URL"
fi

# Fetch from upstream
echo -e "\n${BLUE}Fetching from upstream...${NC}"
git fetch $UPSTREAM_NAME

# Get the remote tracking branch
ORIGIN_BRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "origin/$CURRENT_BRANCH")
echo -e "${BLUE}Remote tracking branch:${NC} $ORIGIN_BRANCH"

# Count commits ahead of upstream
COMMITS_TO_PRESERVE=$(git rev-list --count ${UPSTREAM_NAME}/master..$CURRENT_BRANCH)
COMMITS_BEHIND=$(git rev-list --count $CURRENT_BRANCH..${UPSTREAM_NAME}/master)

echo -e "\n${BLUE}Status:${NC}"
echo -e "  ${GREEN}$COMMITS_TO_PRESERVE${NC} local commit(s) to preserve"
echo -e "  ${YELLOW}$COMMITS_BEHIND${NC} commit(s) behind upstream"

if [ "$COMMITS_BEHIND" -eq 0 ]; then
    echo -e "\n${GREEN}✓ Already up to date with upstream!${NC}"
    exit 0
fi

# Show commits that will be preserved
if [ "$COMMITS_TO_PRESERVE" -gt 0 ]; then
    echo -e "\n${BLUE}Local commits to preserve:${NC}"
    git log --oneline ${UPSTREAM_NAME}/master..$CURRENT_BRANCH | sed 's/^/  /'
fi

# Confirm rebase
echo -e "\n${YELLOW}This will rebase your $COMMITS_TO_PRESERVE local commit(s) on top of $COMMITS_BEHIND upstream commit(s)${NC}"
read -p "Continue with rebase? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Aborted${NC}"
    exit 1
fi

# Perform rebase
echo -e "\n${BLUE}Rebasing on upstream/master...${NC}"
if git rebase ${UPSTREAM_NAME}/master; then
    echo -e "${GREEN}✓${NC} Rebase successful!"
else
    echo -e "\n${RED}Rebase failed with conflicts${NC}"
    echo -e "${YELLOW}Please resolve conflicts and run:${NC}"
    echo -e "  git rebase --continue"
    echo -e "${YELLOW}Then run this script again or push manually:${NC}"
    echo -e "  git push origin $CURRENT_BRANCH --force-with-lease"
    exit 1
fi

# Confirm push
echo -e "\n${YELLOW}Ready to force-push to origin/$CURRENT_BRANCH${NC}"
echo -e "${YELLOW}This will update your remote fork${NC}"
read -p "Push to origin? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Skipped push. You can push manually later:${NC}"
    echo -e "  git push origin $CURRENT_BRANCH --force-with-lease"
    exit 0
fi

# Push to origin
echo -e "\n${BLUE}Pushing to origin...${NC}"
if git push origin $CURRENT_BRANCH --force-with-lease; then
    echo -e "${GREEN}✓${NC} Successfully pushed to origin/$CURRENT_BRANCH"
else
    echo -e "${RED}Push failed${NC}"
    echo -e "${YELLOW}You may need to push manually:${NC}"
    echo -e "  git push origin $CURRENT_BRANCH --force-with-lease"
    exit 1
fi

# Summary
echo -e "\n${GREEN}=== Sync Complete ===${NC}"
echo -e "✓ Fetched ${COMMITS_BEHIND} new commits from upstream"
echo -e "✓ Preserved ${COMMITS_TO_PRESERVE} local commit(s)"
echo -e "✓ Pushed to origin/$CURRENT_BRANCH"
echo -e "\n${BLUE}Latest commits:${NC}"
git log --oneline -5 | sed 's/^/  /'
