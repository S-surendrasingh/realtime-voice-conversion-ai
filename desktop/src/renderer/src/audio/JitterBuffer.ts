import type { AudioFrame } from "@shared/protocol";

export interface JitterBufferStats {
  nextExpectedSequence: number;
  bufferedCount: number;
  highestSequenceSeen: number;
  duplicatesDropped: number;
  lateDropped: number;
  skippedMissing: number;
}

/** Orders converted-audio frames by their echoed-back sequence number (the
 * engine returns the SAME sequence it was sent — see EngineClient.ts) and
 * releases them to a playback callback strictly in order. Frames are never
 * played out of order, duplicated, or silently corrupted: a duplicate is
 * dropped, a late frame (sequence < nextExpectedSequence) is dropped, and a
 * frame that arrives ahead of the next expected sequence is held until
 * either the gap fills in or `maxHoldMs` elapses, after which the missing
 * sequence is skipped so playback can't stall forever on one drop. */
export class JitterBuffer {
  private nextExpectedSequence = 0;
  private started = false;
  private readonly held = new Map<number, AudioFrame>();
  private highestSequenceSeen = -1;
  private duplicatesDropped = 0;
  private lateDropped = 0;
  private skippedMissing = 0;
  private waitStartedAt: number | null = null;

  constructor(
    private readonly maxHoldMs: number,
    private readonly onRelease: (frame: AudioFrame) => void,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Feed one arrived frame. May synchronously release zero or more frames
   * (this one and/or any it unblocks) via the onRelease callback, in
   * strictly ascending sequence order. */
  push(frame: AudioFrame): void {
    if (!this.started) {
      this.started = true;
      this.nextExpectedSequence = frame.sequence;
    }
    this.highestSequenceSeen = Math.max(this.highestSequenceSeen, frame.sequence);

    if (frame.sequence < this.nextExpectedSequence) {
      this.lateDropped += 1;
      return;
    }
    if (this.held.has(frame.sequence)) {
      this.duplicatesDropped += 1;
      return;
    }
    this.held.set(frame.sequence, frame);
    this.drainReady();
  }

  /** Called periodically (e.g. on a timer) so a missing sequence doesn't
   * block playback forever when nothing new ever arrives to trigger
   * drainReady() naturally. */
  tick(): void {
    if (this.held.size === 0 || this.held.has(this.nextExpectedSequence)) {
      this.drainReady();
      return;
    }
    if (this.waitStartedAt === null) {
      this.waitStartedAt = this.now();
      return;
    }
    if (this.now() - this.waitStartedAt >= this.maxHoldMs) {
      this.skippedMissing += 1;
      this.nextExpectedSequence += 1;
      this.waitStartedAt = null;
      this.drainReady();
    }
  }

  private drainReady(): void {
    while (this.held.has(this.nextExpectedSequence)) {
      const frame = this.held.get(this.nextExpectedSequence)!;
      this.held.delete(this.nextExpectedSequence);
      this.onRelease(frame);
      this.nextExpectedSequence += 1;
      this.waitStartedAt = null;
    }
  }

  getStats(): JitterBufferStats {
    return {
      nextExpectedSequence: this.nextExpectedSequence,
      bufferedCount: this.held.size,
      highestSequenceSeen: this.highestSequenceSeen,
      duplicatesDropped: this.duplicatesDropped,
      lateDropped: this.lateDropped,
      skippedMissing: this.skippedMissing,
    };
  }

  reset(): void {
    this.started = false;
    this.nextExpectedSequence = 0;
    this.held.clear();
    this.highestSequenceSeen = -1;
    this.waitStartedAt = null;
  }
}
