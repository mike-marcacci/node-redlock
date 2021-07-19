#!/bin/bash

while [ ! -d "$1" ] && [ ! -f "$1" ]; do

echo "Waiting for '$1' to exist..."
sleep 1

done

eval "${*:2}"