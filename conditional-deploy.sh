#!/bin/sh
echo "Checking commit message..."
if git log -1 --pretty=%B | grep -q "\[skip vercel\]"; then
  echo "Skipping deployment"
  exit 0
fi

echo "Commit message does not contain [skip vercel]. Proceeding with deployment."
exit 1 