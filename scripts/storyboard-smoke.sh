#!/bin/zsh
# Offline smoke test of the storyboard flow (master → segments → storyboards
# → accepted short → render) against a throwaway data dir. Needs macOS `say`
# for synthetic speech, ffmpeg, and WhisperX; no Gemini key (dry run).
#
#   scripts/storyboard-smoke.sh            # uses /tmp/vf-smoke, port 3123
#   SMOKE_DIR=... SMOKE_PORT=... scripts/storyboard-smoke.sh
set -u
cd "$(dirname "$0")/.."
export DATA_DIR=${SMOKE_DIR:-/tmp/vf-smoke}
export BRAND_CONFIG=$DATA_DIR/brand.config.json
export STORYBOARD_DRY_RUN=1
export WHISPERX_MODEL=${WHISPERX_MODEL:-small}
export WHISPERX_LANGUAGE=en
PORT=${SMOKE_PORT:-3123}
BASE=http://localhost:$PORT

rm -rf "$DATA_DIR"; mkdir -p "$DATA_DIR/library"
cp brand.config.example.json "$BRAND_CONFIG"
say -v Samantha -o "$DATA_DIR/a.aiff" "Here is the thing nobody tells you about car accessories. Most of them fall off the dashboard within a week. Our plush duck uses a weighted base, so it stays put even on rough roads."
say -v Samantha -o "$DATA_DIR/b.aiff" "I tested it for a month on gravel and it never moved once. People ask me if it blocks the view. It does not, because it sits low on the dash. If you want one, the link is in the bio."
ffmpeg -y -v error -f lavfi -i "testsrc2=size=720x1280:rate=30" -i "$DATA_DIR/a.aiff" -shortest -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac "$DATA_DIR/library/talk_a.mp4"
ffmpeg -y -v error -f lavfi -i "testsrc2=size=1280x720:rate=30" -i "$DATA_DIR/b.aiff" -shortest -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac "$DATA_DIR/library/talk_b.mov"

npx next dev -p $PORT > "$DATA_DIR/server.log" 2>&1 &
SERVER=$!
for i in {1..60}; do curl -s -o /dev/null $BASE/api/whisperx && break; sleep 2; done

j() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
fail() { echo "FAIL: $1"; kill $SERVER 2>/dev/null; exit 1; }

echo "== whisperx"; curl -s $BASE/api/whisperx; echo
echo "== master"
MASTER=$(curl -s -X POST $BASE/api/master -H 'Content-Type: application/json' \
  -d '{"clips":["talk_a.mp4","talk_b.mov"],"title":"Smoke master","timing_engine":"whisperx"}')
MID=$(echo "$MASTER" | j "d['videoId']") || fail "master: $MASTER"
echo "== analyze $MID"
curl -s -X POST $BASE/api/analyze/$MID | j "d.get('error') or ('shots', len(d['shots']))"
curl -s $BASE/api/master/$MID/segments | j "('timing', d['timing_source'], 'words', len(d['words']), 'segments', len(d['segments']))"
echo "== storyboards"
curl -s -X POST $BASE/api/master/$MID/storyboards -H 'Content-Type: application/json' \
  -d '{"count":2,"lengths":[12,20],"pacing":"standard","allow_broll":false,"brief":""}' > "$DATA_DIR/sb.json"
SBID=$(j "d['storyboards'][0]['id']" < "$DATA_DIR/sb.json") || fail "storyboards: $(cat "$DATA_DIR/sb.json")"
j "[(s['title'], s['target_seconds'], s['estimated_seconds'], len(s['beats'])) for s in d['storyboards']]" < "$DATA_DIR/sb.json"
echo "== accept"
SHORT=$(curl -s -X POST $BASE/api/master/$MID/storyboards/accept -H 'Content-Type: application/json' -d "{\"storyboard_id\":\"$SBID\"}")
SID=$(echo "$SHORT" | j "d['videoId']") || fail "accept: $SHORT"
echo "$SHORT"
curl -s $BASE/api/analyze/$SID/recommendations | j "('keep_source', [s.get('keep_source') for s in d['shots']])"
echo "== render"
curl -s -X POST $BASE/api/analyze/$SID/render -H 'Content-Type: application/json' -d '{"audio":"original","burn_text":true}' \
  | j "d.get('error') or ('audio', d['audio'], 'seconds', d['durationSeconds'], 'sources', [s['clip_source'] for s in d['shots']], 'warnings', d['warnings'])"
ffprobe -v error -show_entries stream=codec_type,duration -of csv=p=0 "$DATA_DIR/renders/$SID.mp4"

kill $SERVER 2>/dev/null; wait $SERVER 2>/dev/null
echo "DONE — artifacts in $DATA_DIR"
