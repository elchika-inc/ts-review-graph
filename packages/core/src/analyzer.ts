import { Project, SourceFile } from "ts-morph";
import { createHash } from "node:crypto";
import { toProjectRelative } from "./paths.js";

export type NodeKind =
  | "file"
  | "function"
  | "class"
  | "interface"
  | "type_alias"
  | "variable"
  | "test";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  file: string;
  line: number;
  signature?: string;
  typeRefs: string[];
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  kind:
    | "IMPORTS_FROM"
    | "TYPED_BY"
    | "IMPLEMENTS"
    | "EXTENDS"
    | "HAS_TEST";
}

export interface AnalysisResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  fileHashes: Map<string, string>;
}

function nodeId(file: string, name: string): string {
  return `${file}::${name}`;
}

function fileId(file: string): string {
  return `${file}::__file__`;
}

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.(ts|tsx)$/.test(file);
}

export function analyzeProject(tsconfigPath: string, projectRoot: string): AnalysisResult {
  const project = new Project({ tsConfigFilePath: tsconfigPath });
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const fileHashes = new Map<string, string>();
  const seenEdges = new Set<string>();

  function addEdge(edge: GraphEdge): void {
    const key = `${edge.sourceId}|${edge.targetId}|${edge.kind}`;
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      edges.push(edge);
    }
  }

  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath();
    if (absPath.includes("node_modules")) continue;
    // プロジェクトルート外のファイル（tsconfig の references 等で入り込む）はグラフに含めない
    let filePath: string;
    try {
      filePath = toProjectRelative(projectRoot, absPath);
    } catch {
      continue;
    }

    const hash = createHash("sha256")
      .update(sf.getFullText())
      .digest("hex");
    fileHashes.set(filePath, hash);

    const kind: NodeKind = isTestFile(filePath) ? "test" : "file";
    nodes.push({
      id: fileId(filePath),
      kind,
      name: filePath.split("/").pop() ?? filePath,
      file: filePath,
      line: 1,
      typeRefs: [],
    });

    // IMPORTS_FROM エッジ
    for (const decl of sf.getImportDeclarations()) {
      const resolved = decl.getModuleSpecifierSourceFile();
      if (resolved) {
        const targetFile = toRelativeOrNull(projectRoot, resolved.getFilePath());
        if (targetFile === null) continue;
        addEdge({
          sourceId: fileId(filePath),
          targetId: fileId(targetFile),
          kind: "IMPORTS_FROM",
        });
      }
    }

    // re-export もファイル依存として扱う
    for (const decl of sf.getExportDeclarations()) {
      const resolved = decl.getModuleSpecifierSourceFile();
      if (resolved) {
        const targetFile = toRelativeOrNull(projectRoot, resolved.getFilePath());
        if (targetFile === null) continue;
        addEdge({
          sourceId: fileId(filePath),
          targetId: fileId(targetFile),
          kind: "IMPORTS_FROM",
        });
      }
    }

    // 関数・クラス・インターフェース・型エイリアスのノードとエッジ
    extractDeclarations(sf, filePath, projectRoot, nodes, addEdge);
  }

  // HAS_TEST エッジ: テストファイルが import する実装ファイルに紐付け
  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath();
    if (!isTestFile(absPath) || absPath.includes("node_modules")) continue;
    const filePath = toRelativeOrNull(projectRoot, absPath);
    if (filePath === null) continue;
    for (const decl of sf.getImportDeclarations()) {
      const resolved = decl.getModuleSpecifierSourceFile();
      if (resolved && !isTestFile(resolved.getFilePath()) && !resolved.getFilePath().includes("node_modules")) {
        const targetFile = toRelativeOrNull(projectRoot, resolved.getFilePath());
        if (targetFile === null) continue;
        addEdge({
          sourceId: fileId(targetFile),
          targetId: fileId(filePath),
          kind: "HAS_TEST",
        });
      }
    }
  }

  return { nodes, edges, fileHashes };
}

function toRelativeOrNull(projectRoot: string, filePath: string): string | null {
  try {
    return toProjectRelative(projectRoot, filePath);
  } catch {
    return null;
  }
}

function extractDeclarations(
  sf: SourceFile,
  filePath: string,
  projectRoot: string,
  nodes: GraphNode[],
  addEdge: (e: GraphEdge) => void
): void {
  // 関数
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const id = nodeId(filePath, name);
    const typeRefs: string[] = [];

    for (const param of fn.getParameters()) {
      const sym = param.getType().getSymbol();
      if (sym) {
        for (const d of sym.getDeclarations()) {
          const targetAbsPath = d.getSourceFile().getFilePath();
          const targetFile = toRelativeOrNull(projectRoot, targetAbsPath);
          if (targetFile !== null && targetFile !== filePath && !targetAbsPath.includes("node_modules")) {
            const targetId = nodeId(targetFile, sym.getName());
            addEdge({ sourceId: id, targetId, kind: "TYPED_BY" });
            typeRefs.push(targetId);
          }
        }
      }
    }

    nodes.push({
      id,
      kind: "function",
      name,
      file: filePath,
      line: fn.getStartLineNumber(),
      typeRefs,
    });
  }

  // クラス
  for (const cls of sf.getClasses()) {
    const name = cls.getName();
    if (!name) continue;
    const id = nodeId(filePath, name);

    for (const impl of cls.getImplements()) {
      const sym = impl.getType().getSymbol();
      if (sym) {
        for (const d of sym.getDeclarations()) {
          const targetAbsPath = d.getSourceFile().getFilePath();
          const targetFile = toRelativeOrNull(projectRoot, targetAbsPath);
          if (targetFile !== null && !targetAbsPath.includes("node_modules")) {
            addEdge({
              sourceId: id,
              targetId: nodeId(targetFile, sym.getName()),
              kind: "IMPLEMENTS",
            });
          }
        }
      }
    }

    const baseClass = cls.getBaseClass();
    if (baseClass) {
      const baseName = baseClass.getName();
      if (baseName) {
        const targetFile = toRelativeOrNull(projectRoot, baseClass.getSourceFile().getFilePath());
        if (targetFile !== null) {
          addEdge({
            sourceId: id,
            targetId: nodeId(targetFile, baseName),
            kind: "EXTENDS",
          });
        }
      }
    }

    // メソッドのパラメータ型参照 → TYPED_BY
    for (const method of cls.getMethods()) {
      for (const param of method.getParameters()) {
        const sym = param.getType().getSymbol();
        if (sym) {
          for (const d of sym.getDeclarations()) {
            const targetAbsPath = d.getSourceFile().getFilePath();
            const targetFile = toRelativeOrNull(projectRoot, targetAbsPath);
            if (targetFile !== null && targetFile !== filePath && !targetAbsPath.includes("node_modules")) {
              addEdge({
                sourceId: id,
                targetId: nodeId(targetFile, sym.getName()),
                kind: "TYPED_BY",
              });
            }
          }
        }
      }
    }

    nodes.push({
      id,
      kind: "class",
      name,
      file: filePath,
      line: cls.getStartLineNumber(),
      typeRefs: [],
    });
  }

  // インターフェース
  for (const iface of sf.getInterfaces()) {
    const name = iface.getName();
    const id = nodeId(filePath, name);

    // getExtends() で型安全に基底インターフェースを取得
    for (const ext of iface.getExtends()) {
      const sym = ext.getType().getSymbol();
      if (sym) {
        for (const d of sym.getDeclarations()) {
          const targetAbsPath = d.getSourceFile().getFilePath();
          const targetFile = toRelativeOrNull(projectRoot, targetAbsPath);
          if (targetFile !== null && !targetAbsPath.includes("node_modules")) {
            addEdge({
              sourceId: id,
              targetId: nodeId(targetFile, sym.getName()),
              kind: "EXTENDS",
            });
          }
        }
      }
    }

    nodes.push({
      id,
      kind: "interface",
      name,
      file: filePath,
      line: iface.getStartLineNumber(),
      typeRefs: [],
    });
  }

  // 型エイリアス
  for (const ta of sf.getTypeAliases()) {
    nodes.push({
      id: nodeId(filePath, ta.getName()),
      kind: "type_alias",
      name: ta.getName(),
      file: filePath,
      line: ta.getStartLineNumber(),
      typeRefs: [],
    });
  }

  // 変数 (const fn = () => ... などのトップレベル変数)
  for (const vs of sf.getVariableStatements()) {
    if (!vs.isExported()) continue; // エクスポートされた変数のみ
    for (const decl of vs.getDeclarations()) {
      const name = decl.getName();
      if (!name) continue;
      nodes.push({
        id: nodeId(filePath, name),
        kind: "variable" as NodeKind,
        name,
        file: filePath,
        line: decl.getStartLineNumber(),
        typeRefs: [],
      });
    }
  }
}
