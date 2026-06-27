#!/bin/sh
# One-time (or CI) helper: rasterise icon.svg into the PNGs Chrome requires.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
SVG="$DIR/icon.svg"
for size in 16 32 48 128; do
  qlmanage -t -s "$size" -o "$DIR" "$SVG" >/dev/null 2>&1
  mv "$DIR/icon.svg.png" "$DIR/icon-$size.png"
  echo "wrote icon-$size.png"
done
