import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventLog } from "../src/event-log.mjs";

test("a fresh event log has no events", () => {
  const log = createEventLog();
  assert.deepEqual(log.getRecentEvents(), []);
});

test("addEvent stamps a timestamp when none is given", () => {
  const log = createEventLog();
  const record = log.addEvent({ type: "session", label: "started" });
  assert.equal(typeof record.timestamp, "string");
  assert.equal(record.label, "started");
});

test("getRecentEvents returns newest-first", () => {
  const log = createEventLog();
  log.addEvent({ type: "a", label: "first" });
  log.addEvent({ type: "b", label: "second" });
  const events = log.getRecentEvents();
  assert.equal(events[0].label, "second");
  assert.equal(events[1].label, "first");
});

test("the log is capped at maxEvents, dropping the oldest entries", () => {
  const log = createEventLog(3);
  for (let i = 0; i < 5; i++) log.addEvent({ type: "tick", label: `event-${i}` });
  const events = log.getRecentEvents(10);
  assert.equal(events.length, 3);
  // Newest-first: the three most recent are event-4, event-3, event-2.
  assert.deepEqual(
    events.map((e) => e.label),
    ["event-4", "event-3", "event-2"]
  );
});

test("getRecentEvents respects a limit smaller than the buffer", () => {
  const log = createEventLog();
  for (let i = 0; i < 5; i++) log.addEvent({ type: "tick", label: `event-${i}` });
  const events = log.getRecentEvents(2);
  assert.deepEqual(
    events.map((e) => e.label),
    ["event-4", "event-3"]
  );
});
