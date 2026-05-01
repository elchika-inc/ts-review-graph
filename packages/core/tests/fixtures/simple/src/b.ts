import { greet, Animal } from "./a.js";

export class Dog implements Animal {
  name = "Dog";
  bark() {
    return greet(this);
  }
}

export function introduce(animal: Animal): string {
  return greet(animal);
}
