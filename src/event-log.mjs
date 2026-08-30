// A small capped, in-memory ring buffer for the Mission Control "live event
// feed" — records real agent activity (session start, tool calls, tool
// results, turn completion) as it happens. Deliberately not persisted: this
// is a hackathon prototype, not a case-history store, and a factory (rather
// than a module-level singleton) keeps it independently testable.

const DEFAULT_MAX_EVENTS = 200;

function createEventLog(maxEvents = DEFAULT_MAX_EVENTS) {
  let events = [];

  function addEvent(entry) {
    const record = { ...entry, timestamp: entry.timestamp ?? new Date().toISOString() };
    events.push(record);
    if (events.length > maxEvents) events = events.slice(-maxEvents);
    return record;
  }

  function getRecentEvents(limit = 50) {
    return events.slice(-limit).reverse();
  }

  return { addEvent, getRecentEvents };
}

export { createEventLog, DEFAULT_MAX_EVENTS };
