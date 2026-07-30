import type { ReviewTimelineWindow } from '../shared/ipc'

export interface TimelineRequestIdentity {
  taskId: string
  revision: number
  englishSha256?: string
  chineseSha256?: string
}

type TimelineFetcher = (identity: TimelineRequestIdentity, milliseconds: number) => Promise<ReviewTimelineWindow>

function sameIdentity(left: TimelineRequestIdentity | undefined, right: TimelineRequestIdentity): boolean {
  return left?.taskId === right.taskId
    && left.revision === right.revision
    && left.englishSha256 === right.englishSha256
    && left.chineseSha256 === right.chineseSha256
}

function covers(window: ReviewTimelineWindow | undefined, identity: TimelineRequestIdentity, milliseconds: number): boolean {
  return window?.taskId === identity.taskId
    && window.revision === identity.revision
    && window.rangeStartMs <= milliseconds
    && milliseconds < window.rangeEndMs
}

export class TimelineWindowCoordinator {
  #identity: TimelineRequestIdentity | undefined
  #window: ReviewTimelineWindow | undefined
  #latestMilliseconds: number | undefined
  #requestPending = false
  #inFlightToken: symbol | undefined
  #generation = 0

  constructor(
    readonly fetch: TimelineFetcher,
    readonly publish: (window: ReviewTimelineWindow) => void
  ) {}

  reset(identity: TimelineRequestIdentity): void {
    if (sameIdentity(this.#identity, identity)) return
    this.#identity = identity
    this.#window = undefined
    this.#latestMilliseconds = undefined
    this.#requestPending = false
    this.#inFlightToken = undefined
    this.#generation += 1
  }

  request(identity: TimelineRequestIdentity, milliseconds: number): void {
    this.reset(identity)
    this.#latestMilliseconds = Math.max(0, Math.round(milliseconds))
    this.#requestPending = !covers(this.#window, identity, this.#latestMilliseconds)
    this.#pump()
  }

  #pump(): void {
    if (this.#inFlightToken || !this.#requestPending || !this.#identity || this.#latestMilliseconds === undefined) return
    const identity = this.#identity
    const requestedMilliseconds = this.#latestMilliseconds
    const generation = this.#generation
    const token = Symbol()
    this.#requestPending = false
    this.#inFlightToken = token
    void this.fetch(identity, requestedMilliseconds)
      .then((next) => {
        if (generation !== this.#generation || !sameIdentity(this.#identity, identity)) return
        const latest = this.#latestMilliseconds ?? requestedMilliseconds
        if (next.taskId === identity.taskId
          && next.revision === identity.revision
          && covers(next, identity, latest)) {
          this.#window = next
          this.#requestPending = false
          this.publish(next)
          return
        }
        if (latest !== requestedMilliseconds && !covers(this.#window, identity, latest)) {
          this.#requestPending = true
        }
      })
      .catch(() => {
        if (generation !== this.#generation || !sameIdentity(this.#identity, identity)) return
        const latest = this.#latestMilliseconds
        if (latest !== undefined && latest !== requestedMilliseconds && !covers(this.#window, identity, latest)) {
          this.#requestPending = true
        }
      })
      .finally(() => {
        if (this.#inFlightToken !== token) return
        this.#inFlightToken = undefined
        this.#pump()
      })
  }
}
