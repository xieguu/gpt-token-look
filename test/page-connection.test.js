const test = require("node:test");
const assert = require("node:assert/strict");
const { setImmediate: flush } = require("node:timers/promises");
const { createPageConnection } = require("../data");

test("page connections share one authenticated stream until explicitly disconnected", async () => {
  const fixture = createFixture();
  const ready = fixture.connection.connect();
  assert.strictEqual(fixture.connection.connect(), ready);
  await ready;
  assert.equal(fixture.requests.length, 1);
  const request = fixture.requests[0];
  assert.equal(request.url, "/api/client");
  assert.equal(request.options.headers["x-token-lens-token"], "fixture-token");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.signal.aborted, false);
  fixture.connection.disconnect();
  assert.equal(request.options.signal.aborted, true);
  await fixture.connection.connect();
  await flush();
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.requests[1].options.signal.aborted, false);
  assert.deepEqual(fixture.errors, []);
  fixture.connection.disconnect();
});

test("authentication and invalid lifecycle responses fail explicitly and release the request", async () => {
  const requests = [];
  let response = new Response(JSON.stringify({ error: "Invalid API token" }), { status: 401 });
  const connection = createPageConnection(async (url, options) => { requests.push(options); return response; }, { onError: assert.fail });
  await assert.rejects(connection.connect(), /Invalid API token/);
  assert.equal(requests[0].signal.aborted, true);
  response = new Response("not a stream", { headers: { "content-type": "text/plain" } });
  await assert.rejects(connection.connect(), /did not provide a page lifecycle connection/);
  assert.equal(requests[1].signal.aborted, true);
});

test("unexpected stream closure is reported and a later connection can recover", async () => {
  const fixture = createFixture();
  await fixture.connection.connect();
  fixture.controllers[0].close();
  await flush();
  assert.equal(fixture.errors.length, 1);
  assert.match(fixture.errors[0].message, /Page connection closed/);
  await fixture.connection.connect();
  assert.equal(fixture.requests.length, 2);
  fixture.connection.disconnect();
  await flush();
  assert.equal(fixture.errors.length, 1);
});

function createFixture() {
  const requests = [];
  const controllers = [];
  const errors = [];
  const connection = createPageConnection(async (url, options) => {
    requests.push({ url, options });
    const stream = new ReadableStream({
      start(controller) {
        controllers.push(controller);
        options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
      }
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }, { getToken: () => "fixture-token", onError: (error) => errors.push(error) });
  return { connection, requests, controllers, errors };
}
