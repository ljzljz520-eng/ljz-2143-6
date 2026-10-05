set -e
B=${BASE_URL:-http://127.0.0.1:3399}
T=${ADMIN_TOKEN:-dev-admin-token}
j(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1"; }
curl -sS -H "X-Admin-Token: $T" -H 'Content-Type: application/json' -d '{"couple_name":"A 新人Longname","hall":"水晶厅","retention_days":30}' $B/api/events > /tmp/e1.json
E1=$(j 'o.id' < /tmp/e1.json)
curl -sS -H "X-Admin-Token: $T" -H 'Content-Type: application/json' -d '{"couple_name":"B Couple","hall":"翡翠厅"}' $B/api/events > /tmp/e2.json
E2=$(j 'o.id' < /tmp/e2.json)
curl -sS -H "X-Admin-Token: $T" -H 'Content-Type: application/json' -d '{"name":"C1","hall":"水晶厅"}' $B/api/devices > /tmp/d1.json
D1=$(j 'o.id' < /tmp/d1.json); T1=$(j 'o.device_token' < /tmp/d1.json)
curl -sS -X POST -H "X-Admin-Token: $T" -H 'Content-Type: application/json' -d "{\"eventId\":\"$E1\"}" $B/api/devices/$D1/bind-event
printf 'AAA' >/tmp/nope
node - <<'NODE'
const fs=require('fs');
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="100%" height="100%" fill="#702"/><text x="50%" y="50%" font-size="100" text-anchor="middle" fill="white">A Wedding</text></svg>`;
const body=JSON.stringify({type:'photo',filename:'a.svg',mimeType:'image/svg+xml',dataBase64:Buffer.from(svg).toString('base64'),licenseHolder:'contract-A'});
fs.writeFileSync('/tmp/asset1.json',body);
NODE
curl -sS -H "X-Admin-Token: $T" -H 'Content-Type: application/json' --data @/tmp/asset1.json $B/api/events/$E1/assets > /tmp/a1.json
A1=$(j 'o.id' < /tmp/a1.json)
node - <<NODE
const design={canvas:{safeMarginX:6,safeMarginY:8},languages:['zh-CN','en'],slides:[{id:'s1',photoAssetId:'$A1',name:{'zh-CN':'超级长的新人姓名压测','en':'Very Long Newlywed Name'},hall:{'zh-CN':'水晶厅','en':'Crystal Hall'},subtitle:{'zh-CN':'欢迎 Welcome','en':'Welcome'},captionPosition:'bottom',darken:.35,focalX:.5,focalY:.5}]};
const body=JSON.stringify({label:'v1',design,fontEmbedded:false});
require('fs').writeFileSync('/tmp/draft.json',body);
NODE
curl -sS -H "X-Admin-Token: $T" -H 'Content-Type: application/json' --data @/tmp/draft.json $B/api/events/$E1/versions/draft > /tmp/v1.json
V1=$(j 'o.id' < /tmp/v1.json)
PUB=$(curl -sS -H "X-Admin-Token: $T" -H 'Content-Type: application/json' -d "{\"deviceIds\":[\"$D1\"]}" $B/api/versions/$V1/publish)
echo "$PUB" | grep -q '"status":"published"'
CMD=$(curl -sS -H "X-Device-Token: $T1" $B/api/device/commands)
echo "$CMD" | grep -q prepare-and-activate
MAN=$(curl -sS -H "X-Device-Token: $T1" $B/api/device/manifest/$V1)
SHA=$(echo "$MAN"|j 'o.assets[0].sha256')
echo "$MAN" | grep -q '"event_lock":true'
curl -f -sS -H "X-Device-Token: $T1" "$B/api/device/asset/$SHA?version=$V1" -o /tmp/asset-download
cat > /tmp/act.json <<JSON
{"versionId":"$V1","state":"active","metrics":{"downloaded":["$SHA"],"hashVerified":true,"eventId":"$E1"}}
JSON
ACT=$(curl -sS -H "X-Device-Token: $T1" -H 'Content-Type: application/json' --data @/tmp/act.json $B/api/device/version-state)
echo "$ACT"|grep -q '"state":"active"'
# half version must be rejected
cat > /tmp/half.json <<JSON
{"versionId":"$V1","state":"active","metrics":{"downloaded":[],"hashVerified":true,"eventId":"$E1"}}
JSON
curl -sS -H "X-Device-Token: $T1" -H 'Content-Type: application/json' --data @/tmp/half.json $B/api/device/version-state | grep -q '拒绝半版切换'
PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
cat > /tmp/proof.json <<JSON
{"versionId":"$V1","slideIndex":0,"kind":"synthetic","dataBase64":"$PNG","metrics":{"width":1,"height":1}}
JSON
curl -sS -H "X-Device-Token: $T1" -H 'Content-Type: application/json' --data @/tmp/proof.json $B/api/device/proof | grep -q proofId
curl -sS -H "X-Admin-Token: $T" $B/api/events/$E1/proofs | grep -q synthetic
# bind to B after A and verify gate prevents B manifest
curl -sS -X POST -H "X-Admin-Token: $T" -H 'Content-Type: application/json' -d "{\"eventId\":\"$E2\"}" $B/api/devices/$D1/bind-event >/tmp/bind.json
grep -q awaiting-provable-wipe /tmp/bind.json
curl -sS -H "X-Device-Token: $T1" $B/api/device/manifest/$V1 | grep -q '活动身份不匹配'
# prove wipe then B event still has no publish => no A assets can be requested by new identity
TASK=$(curl -sS -H "X-Device-Token: $T1" $B/api/device/commands | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.commands.find(x=>x.scope==='event').taskId)})")
PROOF=$(node -e "console.log(require('crypto').createHash('sha256').update('$TASK').digest('hex'))")
curl -sS -H "X-Device-Token: $T1" -H 'Content-Type: application/json' -d "{\"taskId\":\"$TASK\",\"status\":\"deleted\",\"deleted\":[\"assets\",\"state\"],\"proofSha\":\"$PROOF\"}" $B/api/device/wipe-report | grep -q '"status":"deleted"'
curl -sS -H "X-Device-Token: $T1" "$B/api/device/asset/$SHA?version=$V1" | grep -q '已绑定活动'
echo INTEGRATION_OK
# Scheduled release meeting a revoked license while the display is offline must never activate.
FUTURE=$(node -e "console.log(new Date(Date.now()+1000).toISOString())")
curl -sS -H "X-Admin-Token: $T" -H 'Content-Type: application/json' -d '{"couple_name":"C Couple","hall":"银河厅"}' $B/api/events > /tmp/e3.json
E3=$(j 'o.id' < /tmp/e3.json)
curl -sS -H "X-Admin-Token: $T" -H 'Content-Type: application/json' -d '{"name":"C2","hall":"银河厅"}' $B/api/devices > /tmp/d2.json
D2=$(j 'o.id' < /tmp/d2.json); T2=$(j 'o.device_token' < /tmp/d2.json)
curl -sS -X POST -H "X-Admin-Token: $T" -H 'Content-Type: application/json' -d "{\"eventId\":\"$E3\"}" $B/api/devices/$D2/bind-event >/dev/null
curl -sS -H "X-Admin-Token: $T" -H 'Content-Type: application/json' --data @/tmp/asset1.json $B/api/events/$E3/assets > /tmp/a3.json
A3=$(j 'o.id' < /tmp/a3.json)
node - <<NODE
const fs=require('fs');
const design={canvas:{safeMarginX:6,safeMarginY:8},languages:['zh-CN'],slides:[{id:'s1',photoAssetId:'$A3',name:{'zh-CN':'定时新人'},hall:{'zh-CN':'银河厅'},subtitle:{'zh-CN':'欢迎'},captionPosition:'bottom',darken:.35,focalX:.5,focalY:.5}]};
fs.writeFileSync('/tmp/draft3.json',JSON.stringify({label:'timed',design,fontEmbedded:false}));
NODE
curl -sS -H "X-Admin-Token: $T" -H 'Content-Type: application/json' --data @/tmp/draft3.json $B/api/events/$E3/versions/draft > /tmp/v3.json
V3=$(j 'o.id' < /tmp/v3.json)
SCHED=$(curl -sS -H "X-Admin-Token: $T" -H 'Content-Type: application/json' -d "{\"deviceIds\":[\"$D2\"],\"scheduledAt\":\"$FUTURE\"}" $B/api/versions/$V3/publish)
echo "$SCHED"|grep -q '"status":"scheduled"'
curl -sS -H "X-Device-Token: $T2" $B/api/device/commands | grep -q preload
curl -sS -X POST -H "X-Admin-Token: $T" -H 'Content-Type: application/json' -d '{"reason":"scheduling test revocation"}' $B/api/assets/$A3/revoke >/dev/null
sleep 2
curl -sS -H "X-Device-Token: $T2" $B/api/device/commands | grep -q 'safe-screen'
echo SCHEDULE_REVOKE_OK
