import { describe, expect, it } from "vitest";
import { branchRows, branchTitle, type Branch } from "./branches";

const local = (name: string, current = false): Branch => ({ name, remote: null, current });
const onRemote = (name: string): Branch => ({ name, remote: "origin", current: false });

const branches = [local("main", true), local("feature/Suche"), onRemote("feature/login")];

describe("branchTitle", () => {
  it("nennt einen Branch des Remotes mit dem Remote davor", () => {
    expect(branchTitle(local("main"))).toBe("main");
    expect(branchTitle(onRemote("feature/login"))).toBe("origin/feature/login");
  });
});

describe("branchRows", () => {
  it("zeigt ohne Eingabe alle Branches in der gelieferten Reihenfolge", () => {
    expect(branchRows(branches, "")).toEqual(
      branches.map((branch) => ({ kind: "branch", branch })),
    );
  });

  it("findet Branches über einen Teil des Namens, ohne auf Großschreibung zu achten", () => {
    expect(branchRows(branches, "SUCHE")[0]).toEqual({ kind: "branch", branch: branches[1] });
    expect(branchRows(branches, "origin/")[0]).toEqual({ kind: "branch", branch: branches[2] });
  });

  it("bietet nach den Treffern an, einen Branch mit dem eingegebenen Namen anzulegen", () => {
    expect(branchRows(branches, "feature/")).toEqual([
      { kind: "branch", branch: branches[1] },
      { kind: "branch", branch: branches[2] },
      { kind: "create", name: "feature/" },
    ]);
    expect(branchRows(branches, "  ganz-neu ")).toEqual([{ kind: "create", name: "ganz-neu" }]);
  });

  it("bietet keine Anlage an, wenn es den Branch lokal schon gibt", () => {
    expect(branchRows(branches, "main")).toEqual([{ kind: "branch", branch: branches[0] }]);
  });

  it("bietet die Anlage an, wenn es den Namen nur auf dem Remote gibt", () => {
    expect(branchRows(branches, "feature/login")).toEqual([
      { kind: "branch", branch: branches[2] },
      { kind: "create", name: "feature/login" },
    ]);
  });
});
