export async function safe_fetch_stub(url) {
  const response = await fetch(url);
  const body = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: body
  };
}