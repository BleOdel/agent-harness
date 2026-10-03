/** Implementation scope, not an assertion that tools are installed or a project is verified. */
export type Support = 'implemented' | 'limited' | 'gap' | 'unsupported';
export type Stage = 'build' | 'test' | 'ui' | 'preview' | 'manualReview' | 'apply' | 'recovery' | 'package' | 'securityPerformance' | 'release';
export interface Capability {
  id: string;
  title: string;
  level: 'adapter' | 'recipe' | 'diagnostic' | 'unsupported';
  qualification: 'requires-current-evidence' | 'diagnostic-failed' | 'unavailable';
  prerequisites: string[];
  limits: string[];
  stages: Record<Stage, { support: Support; reason: string; providers: string[] }>;
}
const stage = (support: Support, reason: string, ...providers: string[]) => ({ support, reason, providers });
const unsupported = () => stage('unsupported', 'No provider for this route.');
const empty = (): Capability['stages'] => ({ build: unsupported(), test: unsupported(), ui: unsupported(),
  preview: unsupported(), manualReview: unsupported(), apply: unsupported(), recovery: unsupported(),
  package: unsupported(), securityPerformance: unsupported(), release: unsupported() });
const review = stage('limited', 'Human observations and explicit final approval are separate from automation.', 'src/staging/store.ts');
const apply = stage('limited', 'Existing apply routes; ordinary apply/undo crash recovery remains audit F04.', 'src/verbs/work.ts', 'src/staging/apply.ts');
const recovery = stage('limited', 'Timeout and gate checkpoints exist; provider-error retention remains audit F05.', 'src/workspace/work-checkpoints.ts');
const release = stage('limited', 'Artifact staging and GitHub delivery; not full product-build provenance.', 'src/releases/controller.ts', 'src/releases/github.ts');
const browser = stage('limited', 'Chromium on a dependency-free Node server; observation timing remains audit F02.', 'src/browser/controller.ts');
const preview = stage('implemented', 'Isolated exact-candidate preview of dependency-free Node server.', 'src/staging/preview.ts');
const node = (dependencies: boolean): Capability => ({
  id: dependencies ? 'node-dependencies' : 'node-basic', title: dependencies ? 'Single-package Node with dependencies' : 'Dependency-free Node CLI/API/web',
  level: 'adapter', qualification: 'requires-current-evidence',
  prerequisites: ['Node >=26 on host', 'Pinned Linux Docker runtime', 'Pi and selected provider access for agent work', 'Approved checks', ...(dependencies ? ['Approved prepared dependency cache'] : [])],
  limits: ['Single package; no general workspace support.', 'Offline verification; no emulator or GPU in command checks.', 'Sensitive product completion also depends on a supported security/performance evidence route.'],
  stages: { build: stage('implemented', 'Node/npm builder in an isolated copy.', 'src/adapters/node-npm.ts'),
    test: stage('implemented', 'Node/npm tests and operator-approved command observations.', 'src/acceptance/checks.ts'),
    ui: dependencies ? stage('gap', 'Browser controller rejects runtime dependencies (F11).') : browser,
    preview: dependencies ? stage('gap', 'Preview rejects runtime dependencies (F11).') : preview,
    manualReview: review, apply, recovery,
    package: stage('limited', 'Declared build outputs retained through job/artifact workflows.', 'src/jobs/controller.ts'),
    securityPerformance: stage('gap', dependencies ? 'Existing execution rejects runtime dependencies; dependency intelligence is unavailable (F20).' : 'Local HTTP observations exist; complete dependency intelligence is unavailable (F20).', 'src/security/controller.ts', 'src/performance/controller.ts'),
    release,
  },
});
function recipe(id: string, title: string, provider: string, requirements: string[], limits: string[], ui: boolean): Capability {
  return { id, title, level: 'recipe', qualification: 'requires-current-evidence', prerequisites: requirements, limits,
    stages: { ...empty(), build: stage('limited', 'Only the named recipe, not arbitrary project generation.', provider),
      test: stage('limited', 'Recipe-specific evidence requires the actual runtime and pinned inputs.', provider),
      ui: ui ? stage('limited', 'Packaged GUI observations in the selected qualified runtime.', provider) : unsupported(),
      preview: stage('limited', 'Recipe artifacts/observations; not the generic staged web preview.', provider),
      manualReview: review, recovery: stage('limited', 'Recipe-specific interruption support; requires fresh recovery evidence.', provider),
      package: stage('limited', 'Recipe outputs retained as declared artifacts.', provider),
      securityPerformance: stage('gap', 'Sensitive product obligations do not yet have complete domain-specific providers (F20).'), release },
  };
}
const entries: Capability[] = [node(false), node(true), {
  id: 'python-single', title: 'Single-package Python CLI/service', level: 'adapter', qualification: 'requires-current-evidence',
  prerequisites: ['Pinned Python version and Docker image', 'Approved package inputs and offline dependency preparation', 'Pi/provider for agent work', 'Approved checks'],
  limits: ['Single-package pyproject scope; no generic browser/GUI launch.', 'Not a general GPU or notebook execution environment.'],
  stages: { ...empty(), build: stage('implemented', 'Python package adapter.', 'src/adapters/python-pip.ts'),
    test: stage('implemented', 'Configured Python tests and command observations.', 'src/adapters/python-pip.ts', 'src/acceptance/checks.ts'),
    manualReview: review, apply, recovery, package: stage('limited', 'Declared job outputs.', 'src/jobs/controller.ts'),
    securityPerformance: stage('gap', 'No complete Python-specific sensitive-product assessment route.'), release },
},
  recipe('linux-electron', 'Linux Electron GUI recipe', 'src/desktop/runtime.ts', ['Provisioned Linux desktop Docker image', 'Display/GUI instrumentation'], ['Electron packaging/journey recipe, not all Linux desktop frameworks.'], true),
  recipe('macos-electron', 'macOS Electron GUI recipe', 'src/native/gui/controller.ts', ['Provisioned macOS VM and GUI permissions'], ['Selected package/protocol only; qualification is not inherited from historical demonstrations.'], true),
  recipe('macos-native', 'SwiftUI/AppKit GUI recipe', 'src/native/apple/controller.ts', ['Provisioned Mac VM', 'Xcode/Swift toolchain and GUI permissions'], ['Selected native protocol; not arbitrary Xcode project support.'], true),
  recipe('torch-cpu', 'PyTorch CPU classifier and clustering', 'src/torch/workflow.ts', ['Pinned CPU Python/PyTorch runtime', 'Approved data, recipe and evaluation thresholds'], ['Fixed supervised/deep-learning classifier and unsupervised kmeans.', 'Checkpoint structural validation gap F13; do not claim complete recovery until qualified.'], false),
  recipe('metal-regression', 'Metal regression recipe', 'src/metal/workflow.ts', ['Provisioned compatible Mac/Metal runtime', 'Approved recipe/data'], ['Selected training recipe, not arbitrary GPU frameworks.'], false),
  { ...recipe('small-llm-trial', 'Small language-model fine-tuning diagnostic', 'src/torch/llm-trial.py', ['Pinned small model and CPU dependencies', 'Explicit download/runtime allowance'], ['Fixed tiny synthetic-data experiment; no general user-corpus training or model quality/safety certification.'], false), level: 'diagnostic' },
  { id: 'torch-mac-gpu', title: 'PyTorch GPU inside Mac VM', level: 'diagnostic', qualification: 'diagnostic-failed', prerequisites: ['Compatible provisioned Mac VM'], limits: ['Recorded compatibility probe failed; this is not a supported GPU training route.'], stages: empty() },
  ...['android', 'ios', 'windows', 'cuda', 'general-llm-training'].map(id => ({ id, title: id, level: 'unsupported' as const, qualification: 'unavailable' as const, prerequisites: ['A separately implemented and qualified runner'], limits: ['Deferred; no complete supported route in this release.'], stages: empty() })),
];
export function capabilityCatalog(): { version: 1; entries: Capability[] } { return { version: 1, entries: structuredClone(entries) }; }
export function getCapability(id: string): Capability {
  const entry = entries.find(e => e.id === id);
  if (!entry) throw new Error(`Unknown capability: ${id}`);
  return structuredClone(entry);
}
export function capabilitySummary(adapter: string): string {
  if (adapter === 'node-npm') return 'Single-package Node: browser and staged preview currently require a dependency-free app; apply/recovery and product-assessment gaps remain. Run harness capabilities.';
  if (adapter === 'python-pip') return 'Python single-package command workflow; generic browser/GUI and sensitive-product assessment routes are incomplete. Run harness capabilities.';
  throw new Error(`Unsupported adapter: ${adapter}`);
}
