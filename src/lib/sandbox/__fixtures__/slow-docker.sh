#!/bin/sh
# Stands in for the docker CLI. The real one parses argv and reads --env-file
# after the child process already exists, which is what makes deleting the file
# on the 'spawn' event a race. The sleep makes that window observable.
sleep 0.3
while [ $# -gt 0 ]; do
  if [ "$1" = "--env-file" ]; then
    cat "$2" || echo "MISSING_ENV_FILE"
    exit 0
  fi
  shift
done
echo "NO_ENV_FILE_FLAG"
exit 1
