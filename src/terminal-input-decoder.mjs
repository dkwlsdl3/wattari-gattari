import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";

const ESCAPE = "\x1b";

export class TerminalInputDecoder extends Transform {
  #candidate = "";
  #decoder = new StringDecoder("utf8");
  #flushTimer = null;
  #state = "text";

  _transform(chunk, _encoding, callback) {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    let output = "";
    for (const character of this.#decoder.write(chunk)) {
      if (this.#state === "text") {
        if (character === ESCAPE) {
          this.#candidate = character;
          this.#state = "escape";
        } else output += character;
        continue;
      }

      this.#candidate += character;
      if (this.#state === "escape") {
        if (character === "[") this.#state = "csi";
        else output += this.#releaseCandidate();
      } else if (this.#state === "csi") {
        if (character === "<") this.#state = "sgr-mouse";
        else output += this.#releaseCandidate();
      } else if (character === "M" || character === "m") {
        const match = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(this.#candidate);
        if (match) {
          const button = Number(match[1]);
          if ((button & 64) !== 0) {
            this.emit("wheel", { direction: (button & 1) === 0 ? "up" : "down" });
          } else {
            this.emit("mouse", { button, column: Number(match[2]), row: Number(match[3]) });
          }
          this.#releaseCandidate();
        } else output += this.#releaseCandidate();
      } else if (!/[0-9;]/.test(character)) {
        output += this.#releaseCandidate();
      }
    }
    if (output) this.push(output);
    if (this.#candidate) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = null;
        const pending = this.#releaseCandidate();
        if (pending === ESCAPE) {
          this.emit("keypress", "", {
            name: "escape",
            sequence: ESCAPE,
            ctrl: false,
            meta: false,
            shift: false,
          });
        } else if (pending) this.push(pending);
      }, 10);
      this.#flushTimer.unref?.();
    }
    callback();
  }

  _flush(callback) {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    const pending = `${this.#releaseCandidate()}${this.#decoder.end()}`;
    if (pending) this.push(pending);
    callback();
  }

  _destroy(error, callback) {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    callback(error);
  }

  #releaseCandidate() {
    const value = this.#candidate;
    this.#candidate = "";
    this.#state = "text";
    return value;
  }
}
