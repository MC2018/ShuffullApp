import { describe, expect, it } from "vitest";
import { MARQUEE_GAP_PX, MARQUEE_PAUSE_MS, MARQUEE_SPEED_PX_PER_S, planMarquee } from "@/app/components/ui/marqueePlan";

describe("planMarquee", () => {
    it("does not scroll text that fits", () => {
        expect(planMarquee(120, 200)).toEqual({ scroll: false });
        expect(planMarquee(200, 200)).toEqual({ scroll: false });
    });

    it("ignores sub-pixel overflow from rounding", () => {
        expect(planMarquee(200.6, 200)).toEqual({ scroll: false });
    });

    it("does not scroll before both widths are measured", () => {
        expect(planMarquee(0, 200)).toEqual({ scroll: false });
        expect(planMarquee(500, 0)).toEqual({ scroll: false });
        expect(planMarquee(Number.NaN, 200)).toEqual({ scroll: false });
    });

    it("scrolls a long title by its width plus the gap, at a readable speed", () => {
        const plan = planMarquee(400, 200);
        expect(plan.scroll).toBe(true);
        if (!plan.scroll) {
            return;
        }
        expect(plan.distance).toBe(400 + MARQUEE_GAP_PX);
        expect(plan.durationMs).toBe(Math.round(((400 + MARQUEE_GAP_PX) / MARQUEE_SPEED_PX_PER_S) * 1000));
        expect(plan.pauseMs).toBe(MARQUEE_PAUSE_MS);
    });
});
