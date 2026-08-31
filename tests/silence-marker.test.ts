import { describe, expect, it } from "vitest";
import {
  isSilentOperatorFinal,
  OPERATOR_SILENCE_MARKER,
  operatorStepCountFinal,
} from "../packages/policy/src/index.js";

/**
 * Д-3 (fix-run 31.08): a turn that decided to stay silent may say so only with
 * the marker — but the phrases the model produced BEFORE it was asked (19 of
 * 81 finals, stand run 30.08) are caught too. The negatives matter more than
 * the positives: a false positive here swallows a real message.
 */
describe("isSilentOperatorFinal", () => {
  it("accepts the decision in all shapes it was actually made", () => {
    expect(isSilentOperatorFinal("")).toBe(true);
    expect(isSilentOperatorFinal("  \n")).toBe(true);
    expect(isSilentOperatorFinal(OPERATOR_SILENCE_MARKER)).toBe(true);
    expect(isSilentOperatorFinal("  NO_MESSAGE\n")).toBe(true);
    // The stand-run shapes, verbatim.
    expect(isSilentOperatorFinal("Routine progress — staying silent.")).toBe(true);
    expect(isSilentOperatorFinal("No response requested.")).toBe(true);
    expect(isSilentOperatorFinal("Nothing to report")).toBe(true);
    expect(isSilentOperatorFinal("Staying silent.")).toBe(true);
    expect(isSilentOperatorFinal("(no message)")).toBe(true);
  });

  it("never mistakes a real answer for silence", () => {
    // Russian is an answer to the owner by definition.
    expect(isSilentOperatorFinal("Готово.")).toBe(false);
    expect(isSilentOperatorFinal("Пока без новостей, жду сборку.")).toBe(false);
    // Short English that answers a question is not meta.
    expect(isSilentOperatorFinal("Yes.")).toBe(false);
    expect(isSilentOperatorFinal("Done, see the attached file.")).toBe(false);
    // Long English is content whatever it says.
    expect(
      isSilentOperatorFinal(
        "Routine progress on the build: the cache is rebuilt, two of three suites are green, " +
          "the third is flaky and I am rerunning it now; nothing for you to act on yet, but the " +
          "summary will follow with the last suite.",
      ),
    ).toBe(false);
    // The marker inside a sentence is a sentence, not the marker.
    expect(isSilentOperatorFinal("I will reply NO_MESSAGE when there is nothing.")).toBe(false);
  });

  // Incident 31.08 ~10:56 UTC: the daemon's own step-count stub reached the
  // owner from a digest turn — Russian text sails past the Cyrillic brake, yet
  // the stub exists only when the model produced no usable final at all.
  it("recognizes the daemon's step-count stub as silence", () => {
    expect(isSilentOperatorFinal(operatorStepCountFinal(1))).toBe(true);
    expect(isSilentOperatorFinal(operatorStepCountFinal(12))).toBe(true);
    expect(isSilentOperatorFinal(`  ${operatorStepCountFinal(3)}\n`)).toBe(true);
  });

  it("never mistakes a real Russian answer for the stub", () => {
    expect(isSilentOperatorFinal("Готово.")).toBe(false);
    expect(isSilentOperatorFinal("Готово — выполнено всё, что просил.")).toBe(false);
    // The stub inside a sentence is a sentence, not the stub.
    expect(isSilentOperatorFinal(`Кстати, ${operatorStepCountFinal(2)}`)).toBe(false);
    expect(isSilentOperatorFinal(`${operatorStepCountFinal(2)} Продолжаю.`)).toBe(false);
  });
});
