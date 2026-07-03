/**
 * quality-bar.mjs — the single canonical definition of what case BELONGS in the
 * RAG database. Shared by BOTH daily audits so they judge against the exact same bar:
 *   - recall-watchdog.mjs   (catches the verifier wrongly REJECTING good cases)
 *   - precision-auditor.mjs (catches the verifier wrongly ACCEPTING bad cases)
 *
 * This is the (a)-(e) definition + the genuine-repairs allowlist ONLY. Each auditor
 * appends its OWN verdict instruction (wrongly_rejected vs wrongly_accepted), so the
 * shared text never leans one direction. Keeping it in one place stops the two
 * audits from drifting apart.
 */
export const QUALITY_BAR = `A case BELONGS in the database only if ALL hold: (a) the vehicle is a passenger car, light van, or light pickup truck (NOT a motorcycle, heavy truck/HGV, bus, tractor, boat, or quad/ATV); (b) it describes a genuine MALFUNCTION/DEFECT that was actually repaired and confirmed fixed; (c) it is NOT a config/menu question, parts-fitment/where-to-buy, elective upgrade/retrofit/coding, third-party-gadget firmware, "fixed itself", or a preventive-maintenance opinion; (d) the repair was actually CARRIED OUT and CONFIRMED to have fixed the fault — it does NOT matter WHO carried it out (the car's owner, another forum user, or a mechanic all count), BUT the CONFIRMATION must come from the car's OWNER (the SAME user who reported the fault) in a later post explicitly stating the fault is gone / the car works after the repair; another user reporting the fix worked on THEIR OWN car is corroboration, NOT confirmation, and a repair described or paid for with the outcome never stated is NOT confirmed; a fix merely SUGGESTED and never confirmed done, or never confirmed to work, does NOT qualify. The FAULT and the VEHICLE must be described by the car's OWNER, which anchors the case to one real vehicle; (e) the case's stated vehicle matches the vehicle in the cited FAULT posts, not a different car mentioned elsewhere in a multi-vehicle thread. Genuine repairs INCLUDE cleaning, additive/fluid cures, adjustment, re-flashing the car's OWN ECU, rodent-wiring repair, an emulator that RESTORES a failed factory function, and worn-part replacement on classic cars.`;
