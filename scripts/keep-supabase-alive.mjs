const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured.");
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

async function checkResponse(response, operation) {
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`${operation} failed (${response.status}): ${details}`);
  }
}

const writeResponse = await fetch(
  `${supabaseUrl}/rest/v1/keep_alive?on_conflict=id`,
  {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ id: true, last_ping: new Date().toISOString() }),
  },
);
await checkResponse(writeResponse, "Heartbeat write");

const readResponse = await fetch(
  `${supabaseUrl}/rest/v1/keep_alive?id=eq.true&select=id,last_ping`,
  { headers },
);
await checkResponse(readResponse, "Heartbeat read");

const rows = await readResponse.json();
if (!Array.isArray(rows) || !rows.some((row) => row.id === true && row.last_ping)) {
  throw new Error("Heartbeat read did not return the expected row.");
}

console.log("Supabase heartbeat write and read succeeded.");
