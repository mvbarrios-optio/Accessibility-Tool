#!/bin/bash
mkdir -p audits/raw

while IFS= read -r url; do
  url=$(echo "$url" | tr -d '",[]' | xargs)
  [ -z "$url" ] && continue
  name=$(echo "$url" | sed -E 's|https?://||; s|/$||; s|/|_|g')
  [ -z "$name" ] && name="home"
  npx lighthouse "$url" \
    --only-categories=accessibility \
    --output=json --output=html \
    --output-path="./audits/raw/${name}-lighthouse" \
    --chrome-flags="--headless"
  echo "✓ Scanned: $url"
done < <(grep -o '"[^"]*"' urls.json | tr -d '"')
