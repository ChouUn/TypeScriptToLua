import { createVirtualProgram, LuaLibImportKind } from "../../src";
import * as util from "../util";
import * as ts from "typescript";
import { createVisitorMap } from "../../src/transformation";
import { TransformationContext } from "../../src/transformation/context";
import { usingTransformer } from "../../src/transformation/pre-transformers/using-transformer";

const usingTestLib = `
    export const logs: string[] = [];

    function loggedDisposable(id: string): Disposable {
        logs.push(\`Creating \${id}\`);

        return {
            [Symbol.dispose]() {
                logs.push(\`Disposing \${id}\`);
            }
        }
    }`;

test("using disposes object at end of function", () => {
    util.testModule`        
        function func() {
            using a = loggedDisposable("a");
            using b = loggedDisposable("b");

            logs.push("function content");
        }
        
        func();
    `
        .setTsHeader(usingTestLib)
        .expectToEqual({ logs: ["Creating a", "Creating b", "function content", "Disposing b", "Disposing a"] });
});

test("handles multi-variable declarations", () => {
    util.testModule`        
        function func() {
            using a = loggedDisposable("a"), b = loggedDisposable("b");

            logs.push("function content");
        }
        
        func();
    `
        .setTsHeader(usingTestLib)
        .expectToEqual({ logs: ["Creating a", "Creating b", "function content", "Disposing b", "Disposing a"] });
});

test("using disposes object at end of nested block", () => {
    util.testModule`        
        function func() {
            using a = loggedDisposable("a");

            {
                using b = loggedDisposable("b");
                logs.push("nested block");
            }

            logs.push("function content");
        }
        
        func();
    `
        .setTsHeader(usingTestLib)
        .expectToEqual({
            logs: ["Creating a", "Creating b", "nested block", "Disposing b", "function content", "Disposing a"],
        });
});

test("using does not affect function return value", () => {
    util.testModule`        
        function func() {
            using a = loggedDisposable("a");
            using b = loggedDisposable("b");

            logs.push("function content");

            return "success";
        }
        
        export const result = func();
    `
        .setTsHeader(usingTestLib)
        .expectToEqual({
            result: "success",
            logs: ["Creating a", "Creating b", "function content", "Disposing b", "Disposing a"],
        });
});

test("using disposes even when error happens", () => {
    util.testModule` 
        function func() {
            using a = loggedDisposable("a");
            using b = loggedDisposable("b");

            throw "test-induced exception";
        }

        try 
        {
            func();
        }
        catch (e)
        {
            logs.push(\`caught exception: \${e}\`);
        }
    `
        .setTsHeader(usingTestLib)
        .expectToEqual({
            logs: [
                "Creating a",
                "Creating b",
                "Disposing b",
                "Disposing a",
                "caught exception: test-induced exception",
            ],
        });
});

test("await using disposes object with await at end of function", () => {
    util.testModule`
        let disposeAsync;

        function loggedAsyncDisposable(id: string): AsyncDisposable {
            logs.push(\`Creating \${id}\`);

            return {
                [Symbol.asyncDispose]() {
                    logs.push(\`Disposing async \${id}\`);
                    return new Promise(resolve => {
                        disposeAsync = () => {
                            logs.push(\`Disposed \${id}\`);
                            resolve();
                        };
                    });
                }
            }
        }

        async function func() {
            await using a = loggedAsyncDisposable("a");

            logs.push("function content");
            return "function result";
        }
        
        const p = func().then(r => logs.push("promise resolved", r));

        logs.push("function returned");

        disposeAsync();
    `
        .setTsHeader(usingTestLib)
        .setOptions({ luaLibImport: LuaLibImportKind.Inline })
        .expectToEqual({
            logs: [
                "Creating a",
                "function content",
                "Disposing async a",
                "function returned",
                "Disposed a",
                "promise resolved",
                "function result",
            ],
        });
});

test("await using can handle non-async disposables", () => {
    util.testModule`        
        async function func() {
            await using a = loggedDisposable("a");

            logs.push("function content");
        }
        
        func();
    `
        .setTsHeader(usingTestLib)
        .expectToEqual({ logs: ["Creating a", "function content", "Disposing a"] });
});

// https://github.com/TypeScriptToLua/TypeScriptToLua/issues/1571
test("await using no extra diagnostics (#1571)", () => {
    util.testModule`
        async function getResource(): Promise<AsyncDisposable> {
            return {
                [Symbol.asyncDispose]: async () => {}
            };
        }

        async function someOtherAsync() {}

        async function main() {
            await using resource = await getResource();
            await someOtherAsync();
        }
    `.expectToHaveNoDiagnostics();
});

// https://github.com/TypeScriptToLua/TypeScriptToLua/pull/1613
test("using transformer keeps parent chain for recursively transformed nested usings", () => {
    const code = `
        declare function disposable(): Disposable;

        function f() {
            using a = disposable();

            {
                using b = disposable();
            }
        }
    `;

    const program = createVirtualProgram({ "main.ts": code }, { target: ts.ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"] });
    const sourceFile = program.getSourceFile("main.ts");
    util.assert(sourceFile);

    const context = new TransformationContext(program, sourceFile, createVisitorMap([]));
    const transformed = ts.transform(sourceFile, [usingTransformer(context)]).transformed[0];

    type NodeRelation = {
        id: number;
        kind: ts.SyntaxKind;
        text?: string;
        parent: string;
        children: number[];
    };

    const nodeToId = new Map<ts.Node, number>();
    const relations: NodeRelation[] = [];

    const visit = (node: ts.Node) => {
        const id = relations.length;
        nodeToId.set(node, id);
        relations.push({
            id,
            kind: node.kind,
            text: ts.isIdentifier(node) ? node.text : undefined,
            parent: "-",
            children: [],
        });

        ts.forEachChild(node, child => {
            const childId = visit(child);
            relations[id].children.push(childId);
        });

        return id;
    };

    visit(transformed);

    for (const [node, id] of nodeToId.entries()) {
        if (!node.parent) {
            relations[id].parent = "-";
            continue;
        }

        const parentId = nodeToId.get(node.parent);
        relations[id].parent = parentId !== undefined ? String(parentId) : `outside:${ts.SyntaxKind[node.parent.kind]}`;
    }

    const usingIds = relations.filter(r => r.kind === ts.SyntaxKind.Identifier && r.text === "__TS__Using").map(r => r.id);
    expect(usingIds).toHaveLength(2);

    const functionId = relations.find(
        r =>
            r.kind === ts.SyntaxKind.FunctionDeclaration &&
            r.children.some(childId => {
                const child = relations[childId];
                return child.kind === ts.SyntaxKind.Identifier && child.text === "f";
            })
    )?.id;
    util.assert(functionId !== undefined);

    const functionBlockId = relations[functionId].children.find(childId => relations[childId].kind === ts.SyntaxKind.Block);
    util.assert(functionBlockId !== undefined);

    const formatNodeLine = (id: number, depth: number) => {
        const relation = relations[id];
        const text = relation.text ?? "-";
        return `${"  ".repeat(depth)}- ${relation.id} ${ts.SyntaxKind[relation.kind]} ${text} parent=${relation.parent}`;
    };

    const renderTree = (id: number, depth: number): string[] => {
        const lines = [formatNodeLine(id, depth)];
        for (const childId of relations[id].children) {
            lines.push(...renderTree(childId, depth + 1));
        }
        return lines;
    };

    const subtreeIds = new Set<number>();
    const collectSubtree = (id: number) => {
        if (subtreeIds.has(id)) {
            return;
        }
        subtreeIds.add(id);
        for (const childId of relations[id].children) {
            collectSubtree(childId);
        }
    };
    collectSubtree(functionBlockId);

    const mismatchLines: string[] = [];
    for (const relation of relations) {
        if (!subtreeIds.has(relation.id)) {
            continue;
        }

        for (const childId of relation.children) {
            if (!subtreeIds.has(childId)) {
                continue;
            }

            const child = relations[childId];
            const expectedParent = String(relation.id);
            if (child.parent !== expectedParent) {
                mismatchLines.push(
                    `- child ${child.id} ${ts.SyntaxKind[child.kind]} expectedParent=${expectedParent} actualParent=${child.parent}`
                );
            }
        }
    }

    const treeDump = renderTree(functionBlockId, 0).join("\n");
    const mismatchesDump = mismatchLines.length > 0 ? mismatchLines.join("\n") : "none";
    const dump = `tree:\n${treeDump}\nparentMismatches:\n${mismatchesDump}`;

    expect(dump).toBe(`tree:
- 8 Block - parent=outside:FunctionDeclaration
  - 9 ReturnStatement - parent=8
    - 10 CallExpression - parent=9
      - 11 Identifier __TS__Using parent=10
      - 12 FunctionExpression - parent=10
        - 13 Parameter - parent=12
          - 14 Identifier this parent=13
          - 15 VoidKeyword - parent=13
        - 16 Parameter - parent=12
          - 17 Identifier a parent=16
        - 18 AnyKeyword - parent=12
        - 19 Block - parent=12
          - 20 Block - parent=19
            - 21 ReturnStatement - parent=20
              - 22 CallExpression - parent=21
                - 23 Identifier __TS__Using parent=22
                - 24 FunctionExpression - parent=22
                  - 25 Parameter - parent=24
                    - 26 Identifier this parent=25
                    - 27 VoidKeyword - parent=25
                  - 28 Parameter - parent=24
                    - 29 Identifier b parent=28
                  - 30 AnyKeyword - parent=24
                  - 31 Block - parent=24
                - 32 CallExpression - parent=22
                  - 33 Identifier disposable parent=32
      - 34 CallExpression - parent=10
        - 35 Identifier disposable parent=34
parentMismatches:
none`);
});

// https://github.com/TypeScriptToLua/TypeScriptToLua/issues/1584
test("works with disposable classes (#1584)", () => {
    util.testFunction`
        const log = [];
        
        class Scoped {
            action(): void {
                log.push("action")
            }
            [Symbol.dispose]() {
                log.push("cleanup")
            }
        }

        function TestScoped(): void {
            using s = new Scoped();
            s.action();
        }

        TestScoped();
        return log;
    `.expectToEqual(["action", "cleanup"]);
});
