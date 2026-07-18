export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let value = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    value = value + Math.imul(value ^ (value >>> 7), 61 | value) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  integer(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  pick<T>(values: readonly T[]): T {
    const value = values[this.integer(0, values.length - 1)];
    if (value === undefined) throw new Error("Cannot pick from an empty collection");
    return value;
  }

  shuffle<T>(values: readonly T[]): T[] {
    const output = [...values];
    for (let index = output.length - 1; index > 0; index -= 1) {
      const target = this.integer(0, index);
      [output[index], output[target]] = [output[target]!, output[index]!];
    }
    return output;
  }
}
