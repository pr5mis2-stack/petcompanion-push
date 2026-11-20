// 가루 잠금화면 카드(Live Activity) 방송 푸시
//
//   node apns.mjs create-channel sandbox|production   채널 만들기 (처음 한 번)
//   node apns.mjs list-channels  sandbox|production   만든 채널 목록 보기
//   node apns.mjs send                                 모든 카드에 "지금 장면으로 바꿔" 보내기
//
// 필요한 환경변수 (GitHub › Settings › Secrets 에 넣는다. 코드에는 비밀값이 없다)
//   APNS_KEY        .p8 파일 내용 전체 (-----BEGIN PRIVATE KEY----- 부터 END 까지)
//   APNS_KEY_ID     키 ID (10자리)
//   APNS_TEAM_ID    팀 ID (10자리)
//   CHANNEL_SANDBOX / CHANNEL_PRODUCTION   채널 ID (create-channel 결과)
//   BUNDLE_ID       (선택) 기본값 com.pr5mis2.PetCompanion

import http2 from "node:http2";
import crypto from "node:crypto";

const BUNDLE_ID = process.env.BUNDLE_ID || "com.pr5mis2.PetCompanion";

const HOSTS = {
  sandbox: {
    manage: "https://api-manage-broadcast.sandbox.push.apple.com:2195",
    send: ["https://api.sandbox.push.apple.com:443", "https://api-broadcast.sandbox.push.apple.com:443"],
  },
  production: {
    manage: "https://api-manage-broadcast.push.apple.com:2196",
    send: ["https://api.push.apple.com:443", "https://api-broadcast.push.apple.com:443"],
  },
};

function need(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`환경변수 ${name} 가 비어 있어요.`);
  return v.trim();
}

// APNs 인증 토큰 (ES256 JWT)
function jwt() {
  const key = need("APNS_KEY").replace(/\\n/g, "\n");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "ES256", kid: need("APNS_KEY_ID") });
  const body = b64({ iss: need("APNS_TEAM_ID"), iat: Math.floor(Date.now() / 1000) });
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${sig.toString("base64url")}`;
}

function request(origin, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(origin);
    client.on("error", reject);
    const req = client.request({ ":method": method, ":path": path, ...headers });
    let data = "";
    let resHeaders = {};
    req.on("response", (h) => (resHeaders = h));
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      client.close();
      resolve({ status: resHeaders[":status"], headers: resHeaders, body: data });
    });
    req.on("error", (e) => { client.close(); reject(e); });
    req.setTimeout(15000, () => { req.close(); client.close(); reject(new Error("시간 초과")); });
    if (body) req.write(body);
    req.end();
  });
}

async function createChannel(env) {
  const res = await request(HOSTS[env].manage, "POST", `/1/apps/${BUNDLE_ID}/channels`,
    { authorization: `bearer ${jwt()}`, "content-type": "application/json" },
    JSON.stringify({ "message-storage-policy": 0, "push-type": "LiveActivity" }));
  if (res.status !== 201) throw new Error(`채널 만들기 실패 (${res.status}) ${res.body}`);
  console.log(`\n✅ ${env} 채널 ID: ${res.headers["apns-channel-id"]}\n`);
}

async function listChannels(env) {
  const res = await request(HOSTS[env].manage, "GET", `/1/apps/${BUNDLE_ID}/all-channels`,
    { authorization: `bearer ${jwt()}` });
  console.log(`${env} (${res.status}):`, res.body || "(비어 있음)");
}

async function sendUpdate(env, channel) {
  // ActivityKit 은 Date 를 "2001-01-01 기준 초"로 읽는다.
  const updatedAt = Date.now() / 1000 - 978307200;
  const payload = JSON.stringify({
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event: "update",
      "content-state": { updatedAt },
    },
  });
  const headers = {
    authorization: `bearer ${jwt()}`,
    "apns-push-type": "liveactivity",
    "apns-channel-id": channel,
    "apns-priority": "5",
    "apns-expiration": "0",
    "content-type": "application/json",
  };
  let lastError;
  for (const origin of HOSTS[env].send) {
    try {
      const res = await request(origin, "POST", `/4/broadcasts/apps/${BUNDLE_ID}`, headers, payload);
      if (res.status === 200) {
        console.log(`✅ ${env}: 보냄 (${origin})`);
        return;
      }
      lastError = new Error(`${env}: 실패 (${res.status}) ${res.body}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function main() {
  const [cmd, env] = process.argv.slice(2);
  if (cmd === "create-channel" || cmd === "list-channels") {
    if (!HOSTS[env]) throw new Error("sandbox 또는 production 을 적어 주세요.");
    return cmd === "create-channel" ? createChannel(env) : listChannels(env);
  }
  if (cmd === "send") {
    const targets = [["sandbox", process.env.CHANNEL_SANDBOX], ["production", process.env.CHANNEL_PRODUCTION]]
      .filter(([, c]) => c && c.trim());
    if (!targets.length) throw new Error("CHANNEL_SANDBOX / CHANNEL_PRODUCTION 중 하나는 있어야 해요.");
    let failed = 0;
    for (const [e, c] of targets) {
      try { await sendUpdate(e, c.trim()); } catch (err) { failed++; console.error("❌", err.message); }
    }
    if (failed === targets.length) process.exit(1);
    return;
  }
  console.log("사용법: node apns.mjs create-channel|list-channels sandbox|production  또는  node apns.mjs send");
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
