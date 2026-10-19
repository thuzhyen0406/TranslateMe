function handler(event) {
  var req = event.request;
  var m = /^\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\/|$)/.exec(req.uri);
  if (!m) return { statusCode: 404, statusDescription: 'Not Found' };
  return req;
}