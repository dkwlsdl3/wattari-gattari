export class InputHistory {
  #entries = [];
  #cursor = null;
  #draft = "";

  setEntries(entries) {
    const nextEntries = entries.filter((entry) => typeof entry === "string" && entry.length > 0);
    const unchanged = nextEntries.length === this.#entries.length
      && nextEntries.every((entry, index) => entry === this.#entries[index]);
    if (unchanged) return;

    this.#entries = nextEntries;
    this.reset();
  }

  previous(currentInput) {
    if (!this.#entries.length) return currentInput;
    if (this.#cursor === null) {
      this.#draft = currentInput;
      this.#cursor = this.#entries.length;
    }

    this.#cursor = Math.max(0, this.#cursor - 1);
    return this.#entries[this.#cursor];
  }

  next(currentInput) {
    if (this.#cursor === null) return currentInput;
    if (this.#cursor < this.#entries.length - 1) {
      this.#cursor += 1;
      return this.#entries[this.#cursor];
    }

    const draft = this.#draft;
    this.reset();
    return draft;
  }

  reset() {
    this.#cursor = null;
    this.#draft = "";
  }
}
