export interface Animal {
  name: string;
}

export function greet(a: Animal): string {
  return `Hello, ${a.name}`;
}
