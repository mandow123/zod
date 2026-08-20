import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) files.push(path);
  }
  return files;
}

function parameterName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isCallExpression(expression) && expression.arguments.length > 0) return parameterName(expression.arguments[0]);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return 'value';
}

function literalPath(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return null;
  return node.head.text + node.templateSpans
    .map((span) => `:${parameterName(span.expression)}${span.literal.text}`)
    .join('');
}

function normalizedPath(path) {
  return path.split('?')[0].replace(/:[^/]+/gu, ':parameter').replace(/\/$/u, '') || '/';
}

function requestMethod(options) {
  if (!options || !ts.isObjectLiteralExpression(options)) return 'GET';
  const property = options.properties.find((item) => ts.isPropertyAssignment(item)
    && ((ts.isIdentifier(item.name) && item.name.text === 'method')
      || (ts.isStringLiteralLike(item.name) && item.name.text === 'method')));
  return property && ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)
    ? property.initializer.text.toUpperCase()
    : 'GET';
}

function resolvedRequestMethod(options) {
  if (options && ts.isCallExpression(options) && ts.isIdentifier(options.expression)
    && options.expression.text === 'mutation') return 'POST';
  return requestMethod(options);
}

async function collectFrontendRequests() {
  const requests = [];
  for (const file of await sourceFiles(join(root, 'src'))) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function insideFunction(node, name) {
      for (let current = node.parent; current; current = current.parent) {
        if (ts.isFunctionDeclaration(current) && current.name?.text === name) return true;
      }
      return false;
    }
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'apiRequest') {
        const path = literalPath(node.arguments[0]);
        if (!path) throw new Error(`${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: apiRequest path must be a literal or template literal.`);
        if (!insideFunction(node, 'orderAction')) {
          requests.push({
            method: resolvedRequestMethod(node.arguments[1]), path, normalized: normalizedPath(path),
            file: relative(root, file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          });
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'orderAction') {
        const actionPath = literalPath(node.arguments[1]);
        if (!actionPath) throw new Error(`${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: orderAction path must be literal.`);
        const path = `/mobile/v1/${actionPath.replace('{orderId}', ':orderId')}`;
        requests.push({
          method: 'POST', path, normalized: normalizedPath(path),
          file: relative(root, file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return requests;
}

async function collectBackendRoutes() {
  const routes = [];
  const files = [
    ...await sourceFiles(join(root, 'backend', 'src')),
    ...await sourceFiles(join(root, 'backend', 'staging-sandbox')),
  ];
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'app'
        && ['get', 'post', 'put', 'delete', 'patch'].includes(node.expression.name.text)) {
        const path = literalPath(node.arguments[0]);
        if (path) routes.push({
          method: node.expression.name.text.toUpperCase(), path, normalized: normalizedPath(path),
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return routes;
}

const [requests, routes] = await Promise.all([collectFrontendRequests(), collectBackendRoutes()]);
const routeKeys = new Set(routes.map(({ method, normalized }) => `${method} ${normalized}`));
const invalidScope = requests.filter(({ path }) => !path.startsWith('/mobile/v1/'));
const missing = requests.filter(({ method, normalized }) => !routeKeys.has(`${method} ${normalized}`));

if (requests.length < 50) throw new Error(`Only ${requests.length} frontend API calls were detected; contract scan is unexpectedly incomplete.`);
if (invalidScope.length > 0 || missing.length > 0) {
  for (const request of invalidScope) process.stderr.write(`Frontend request outside mobile API: ${request.method} ${request.path} (${request.file}:${request.line})\n`);
  for (const request of missing) process.stderr.write(`Backend route missing: ${request.method} ${request.path} (${request.file}:${request.line})\n`);
  process.exit(1);
}

const uniqueContracts = new Set(requests.map(({ method, normalized }) => `${method} ${normalized}`));
process.stdout.write(`Mobile frontend/backend contract passed: ${requests.length} calls, ${uniqueContracts.size} route contracts.\n`);
