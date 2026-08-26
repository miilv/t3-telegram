import { describe, expect, it } from "vitest";
import { localApprovalResult } from "../apps/daemon/src/operator-daemon.js";

describe("local approval replay outcomes", () => {
  it("only reports an accepted confirmation as applied", () => {
    expect(localApprovalResult("accept")).toEqual({ applied: true, outcome: "accepted" });
    expect(localApprovalResult("auto-accepted")).toEqual({ applied: true, outcome: "accepted" });
    expect(localApprovalResult("decline")).toEqual({ applied: false, outcome: "declined" });
    expect(localApprovalResult("expired")).toEqual({ applied: false, outcome: "expired" });
    expect(localApprovalResult("superseded")).toEqual({ applied: false, outcome: "superseded" });
  });
});
