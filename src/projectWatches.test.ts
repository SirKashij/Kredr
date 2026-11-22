import { expect, test } from "vitest";
import { ProjectWatches } from "./projectWatches";

/** Beobachter, die nur festhalten, wann sie starten und enden. */
function recording() {
  const events: string[] = [];
  const watches = new ProjectWatches((project) => {
    events.push(`start ${project}`);
    return () => events.push(`stop ${project}`);
  });
  return { events, watches };
}

test("jedes Projekt bekommt seinen eigenen Beobachter", () => {
  const { events, watches } = recording();

  watches.follow(["C:\\Web", "C:\\Kern"]);

  expect(events).toEqual(["start C:\\Web", "start C:\\Kern"]);
});

test("kommt ein Projekt hinzu, startet nur sein Beobachter", () => {
  const { events, watches } = recording();
  watches.follow(["C:\\Web"]);
  events.length = 0;

  watches.follow(["C:\\Web", "C:\\Kern"]);

  expect(events).toEqual(["start C:\\Kern"]);
});

test("fällt ein Projekt weg, endet nur sein Beobachter", () => {
  const { events, watches } = recording();
  watches.follow(["C:\\Web", "C:\\Kern"]);
  events.length = 0;

  watches.follow(["C:\\Kern"]);

  expect(events).toEqual(["stop C:\\Web"]);
});

test("eine neue Reihenfolge startet keinen Beobachter neu", () => {
  const { events, watches } = recording();
  watches.follow(["C:\\Web", "C:\\Kern"]);
  events.length = 0;

  watches.follow(["C:\\Kern", "C:\\Web"]);

  expect(events).toEqual([]);
});

test("dasselbe Projekt in anderer Schreibweise behält seinen Beobachter", () => {
  const { events, watches } = recording();
  watches.follow(["C:\\Web"]);
  events.length = 0;

  watches.follow(["c:\\web"]);

  expect(events).toEqual([]);
});

test("ohne Projekte endet jeder Beobachter", () => {
  const { events, watches } = recording();
  watches.follow(["C:\\Web", "C:\\Kern"]);
  events.length = 0;

  watches.follow([]);

  expect(events).toEqual(["stop C:\\Web", "stop C:\\Kern"]);
});
