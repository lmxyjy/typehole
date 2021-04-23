import * as vscode from "vscode";
import f from "fastify";

import {
  getWrappingVariableDeclaration,
  insertTypeReference,
  getTypeAliasForId,
  getAllDependencyTypeDeclarations,
} from "./transforms/insertTypes";
import { mergeInterfaces } from "./transforms/mergeInterfaces";
import { isExpression } from "./parse/expression";
import { wrapIntoRecorder } from "./transforms/wrapIntoRecorder";
import {
  getAST,
  findTypeHoleImport,
  getNodeEndPosition,
  getTypeHoleImport,
  findLastImport,
  findTypeholes,
  getNodeStartPosition,
  getParentOnRootLevel,
} from "./parse/module";
import * as ts from "typescript";

import { tsquery } from "@phenomnomnominal/tsquery";

const fastify = f({ logger: true });
fastify.register(require("fastify-cors"));

const last = (arr: any[]) => arr[arr.length - 1];

const PLACEHOLDER_TYPE = "AutoDiscovered";

function startRenamingPlaceholderType(
  editor: vscode.TextEditor,
  document: vscode.TextDocument
) {
  const fullFile = document.getText();
  const ast = getAST(fullFile);

  tsquery
    .query(ast, `TypeAliasDeclaration > Identifier[name="${PLACEHOLDER_TYPE}"]`)
    .forEach(async (node) => {
      const start = getNodeStartPosition(node);
      const end = getNodeEndPosition(node);

      editor.selection = new vscode.Selection(
        new vscode.Position(start.line, start.character),
        new vscode.Position(end.line, end.character)
      );

      await vscode.commands.executeCommand("editor.action.rename");
    });
}

const getEditorRange = (node: ts.Node) => {
  const start = getNodeStartPosition(node);
  const end = getNodeEndPosition(node);
  return new vscode.Range(
    new vscode.Position(start.line, start.character),
    new vscode.Position(end.line, end.character)
  );
};

function insertTypeholeImport(
  ast: ts.Node,
  editBuilder: vscode.TextEditorEdit
) {
  const lastImport = findLastImport(ast);
  const position = lastImport
    ? getNodeEndPosition(lastImport)
    : new vscode.Position(0, 0);

  const existingImport = findTypeHoleImport(ast);

  if (existingImport.length === 0) {
    editBuilder.insert(
      new vscode.Position(position.line, position.character),
      "\n" + getTypeHoleImport() + "\n"
    );
  }
}

function insertRecorderToSelection(
  id: number,
  editor: vscode.TextEditor,
  editBuilder: vscode.TextEditorEdit
) {
  const selectedText = editor.document.getText(editor.selection);
  editBuilder.replace(editor.selection, wrapIntoRecorder(id, selectedText));
}

export function activate(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor!;
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      ["typescript", "typescriptreact"],
      new TypeHoler()
    )
  );

  vscode.commands.registerCommand(
    "extension.typehole.add-a-typehole",
    async () => {
      const editor = vscode.window.activeTextEditor;
      const document = editor?.document;
      if (!editor || !document) {
        return;
      }

      const fullFile = document.getText();
      const ast = getAST(fullFile);
      const id = findTypeholes(ast).length;

      await editor.edit((editBuilder) => {
        insertTypeholeImport(ast, editBuilder);
        insertRecorderToSelection(id, editor, editBuilder);
      });

      const fileWithImportAndRecorder = document.getText();

      const updatedAST = getAST(fileWithImportAndRecorder);

      const newlyCreatedTypeHole = last(findTypeholes(updatedAST));

      const variableDeclaration = getWrappingVariableDeclaration(
        newlyCreatedTypeHole
      );

      await editor.edit((editBuilder) => {
        if (variableDeclaration) {
          insertTypeToVariableDeclaration(
            variableDeclaration,
            updatedAST,
            editBuilder
          );
        }

        /* Add a placeholder type */
        insertAPlaceholderType(editBuilder, newlyCreatedTypeHole);
      });

      startRenamingPlaceholderType(editor, document);
    }
  );

  startListenerServer((id: string, types: string) => {
    const ast = tsquery.ast(editor.document.getText());
    const typeAliasNode = getTypeAliasForId(id, ast);
    if (!typeAliasNode) {
      return;
    }
    const typeName = typeAliasNode.getText();
    // Array is placed by the runtime library so all samples affect the outcome
    const isSimpleType = !types.includes(
      "type IRootObject = IRootObjectItem[];"
    );
    const typesWithoutArrayRoot = isSimpleType
      ? types.replace("IRootObject", typeName).replace("[]", "")
      : types
          .replace("type IRootObject = IRootObjectItem[];", "")
          .replace("IRootObjectItem", typeName);

    const existingDeclarations = getAllDependencyTypeDeclarations(
      typeAliasNode.parent
    );

    return editor.edit((editBuilder) => {
      existingDeclarations.forEach((node) => {
        const range = getEditorRange(node);
        editBuilder.delete(range);
      });
      editBuilder.insert(
        getEditorRange(typeAliasNode.parent).start,
        mergeInterfaces(typesWithoutArrayRoot)
      );
    });
  });
}

function insertAPlaceholderType(
  editBuilder: vscode.TextEditorEdit,
  newTypeHole: any
) {
  editBuilder.insert(
    getEditorRange(getParentOnRootLevel(newTypeHole)).start,
    `type ${PLACEHOLDER_TYPE} = any\n\n`
  );
}

function insertTypeToVariableDeclaration(
  variableDeclaration: ts.Node,
  ast: ts.SourceFile,
  editBuilder: vscode.TextEditorEdit
) {
  const variableDeclationWithNewType = insertTypeReference(
    variableDeclaration,
    PLACEHOLDER_TYPE,
    ast
  );
  const start = getNodeStartPosition(variableDeclaration);
  const end = getNodeEndPosition(variableDeclaration);
  if (variableDeclationWithNewType) {
    editBuilder.replace(
      new vscode.Range(
        new vscode.Position(start.line, start.character),
        new vscode.Position(end.line, end.character)
      ),
      variableDeclationWithNewType
    );
  }
}

function startListenerServer(
  onTypeExtracted: (id: string, types: string) => void
) {
  fastify.post("/type", async (request, reply) => {
    const body = request.body as any;

    onTypeExtracted(body.id, body.interfaces as string);
    return {};
  });

  // Run the server!
  const start = async () => {
    try {
      await fastify.listen(17341);
    } catch (err) {
      console.error(err);
    }
  };
  start();
}

// this method is called when your extension is deactivated
export function deactivate() {
  fastify.close();
}

class TypeHoler implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.ProviderResult<vscode.Command[]> {
    const selectedText = document.getText(range);
    const shouldOfferAction = isExpression(selectedText);
    if (!shouldOfferAction) {
      return;
    }

    return [
      {
        command: "extension.typehole.add-a-typehole",
        title: "Add a typehole",
      },
    ];
  }
}
