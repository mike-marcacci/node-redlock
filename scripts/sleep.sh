#!/bin/bash

echo "Sleeping for $1 seconds..."
sleep $1

eval "${*:2}"