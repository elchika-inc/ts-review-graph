const fakeCoreUrl = new URL("./abi-core.mjs", import.meta.url).href;

// CLI 本体はそのまま実行し、native DB を開く core 境界だけを差し替える。
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@elchika-inc/ts-review-graph-core") {
    return { url: fakeCoreUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
