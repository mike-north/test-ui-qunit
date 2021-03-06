import {
  JSReporters,
  RunEndEvent,
  RunStartEvent,
  SuiteEndEvent,
  SuiteStartEvent,
  TestDataEventMap,
  TestEndEvent,
  TestInfo,
  TestStartEvent
} from '@test-ui/core';
import BiteLog, { Level } from 'bite-log';

const log = new BiteLog(Level.debug);

interface QUnitEventMap {
  suiteStart: QUnit.ModuleStartDetails;
  suiteEnd: QUnit.ModuleDoneDetails;
  testStart: QUnit.TestStartDetails;
  testEnd: QUnit.TestDoneDetails;
  runStart: QUnit.BeginDetails;
  runEnd: QUnit.DoneDetails;
}

interface PrivateQAssertionReport {
  message: string;
  passed: boolean;
  stack: string | undefined;
  todo: boolean;
}
interface PrivateQTestReport {
  name: string;
  assertions: PrivateQAssertionReport[];
  fullName: string[];
  suiteName: string;
  skipped: boolean;
  todo: boolean;
  valid: boolean;
  _startTime: number;
  _endTime: number;
}
interface PrivateQSuiteReport {
  childSuites: PrivateQSuiteReport[];
  fullName: string[];
  name: string;
  _startTime: number;
  _endTime: number;
  tests: PrivateQTestReport[];
}
interface PrivateQModInfo {
  name: string;
  moduleId: string;
  childModules: PrivateQModInfo[];
  stats: {
    all: number;
    bad: number;
    started: number;
  };
  suiteReport: PrivateQSuiteReport;
  skip: boolean | undefined;
  testsRun: number;
  todo: boolean | undefined;
  unskippedTestsRun: number;
}

function testReportToTestInfo(
  suiteName: string,
  tr: PrivateQTestReport
): TestInfo {
  return {
    id: `${suiteName}/${tr.name}`,
    name: tr.name,
    fullName: tr.fullName,
    suiteName
  };
}

function normalizeAssertion(a: QUnit.LogDetails): JSReporters.Assertion {
  return {
    message: a.message,
    passed: a.result,
    expected: a.expected,
    actual: a.actual,
    todo: false // TODO
  };
}

function testReportToTestStart(
  suiteName: string,
  tr: PrivateQTestReport
): JSReporters.TestStart & { id: string } {
  return {
    id: `${suiteName}/${tr.name}`,
    name: tr.name,
    fullName: tr.fullName,
    suiteName
  };
}
function testReportToTestEnd(
  suiteName: string,
  tr: PrivateQTestReport,
  assertions: QUnit.LogDetails[]
): JSReporters.TestEnd & { id: string } {
  const errors = assertions.filter(a => !a.result).map(normalizeAssertion);
  return {
    id: `${suiteName}/${tr.name}`,
    name: tr.name,
    fullName: tr.fullName,
    suiteName,
    status: errors.length > 0 ? 'failed' : 'passed', // TODO
    runtime: tr._endTime - tr._startTime,
    errors,
    assertions: assertions.map(normalizeAssertion)
  };
}
function suiteReportToSuiteStart(
  sr: PrivateQSuiteReport
): JSReporters.SuiteStart {
  return {
    name: sr.name,
    fullName: sr.fullName,
    childSuites: sr.childSuites.map(suiteReportToSuiteStart),
    tests: sr.tests.map(tr => testReportToTestInfo(sr.name, tr)),
    testCounts: {
      total: sr.tests.length
    }
  };
}
function suiteInfoToSuiteStart(
  mod: PrivateQModInfo
): JSReporters.SuiteStart & { id?: string } {
  const tests = mod.suiteReport.tests.map(rawTest =>
    testReportToTestInfo(mod.moduleId, rawTest)
  );
  return {
    name: mod.name,
    fullName: mod.suiteReport.fullName,
    childSuites: mod.suiteReport.childSuites.map(suiteReportToSuiteStart),
    tests,
    testCounts: {
      total: tests.length
    }
  };
}
function suiteInfoToSuiteEnd(
  mod: PrivateQModInfo,
  assertions?: { [k: string]: QUnit.LogDetails[] | undefined }
): JSReporters.SuiteEnd & { id?: string } {
  const tests = mod.suiteReport.tests.map(rawTest => {
    const rawTestAssertions = assertions ? assertions[rawTest.name] : [];
    const testAssertions: QUnit.LogDetails[] =
      typeof rawTestAssertions !== 'undefined'
        ? rawTestAssertions
        : ([] as QUnit.LogDetails[]);
    return testReportToTestEnd(mod.moduleId, rawTest, testAssertions);
  });
  const testCounts = tests.reduce(
    (ct, t) => {
      ct.total++;
      switch (t.status) {
        case 'failed':
          ct.failed++;
          break;
        case 'passed':
          ct.passed++;
          break;
        case 'todo':
          ct.todo++;
          break;
        case 'skipped':
          ct.skipped++;
          break;
      }
      return ct;
    },
    {
      total: 0,
      passed: 0,
      skipped: 0,
      todo: 0,
      failed: 0
    }
  );
  return {
    name: 'root',
    fullName: ['root'],
    childSuites: [suiteReportToSuiteStart(mod.suiteReport)],
    status: 'passed', // TODO
    runtime: mod.suiteReport._endTime - mod.suiteReport._startTime,
    tests,
    testCounts
  };
}

function serializableQunitModules(
  qUnit: Pick<QUnit, 'config'>
): PrivateQModInfo[] {
  return (qUnit.config as any).modules.map((m: any) => ({
    ...m,
    ...{ hooks: null }
  }));
}

function moduleInfoByName(
  qUnit: Pick<QUnit, 'config'>,
  name: string
): PrivateQModInfo[] {
  const mods = serializableQunitModules(qUnit);
  const matches = mods.filter(m => m.name === name);
  if (matches.length === 0) {
    throw new Error(
      `Module "${name}" mentioned in event, but not found in QUnit state\nOnly found(${mods
        .map(m => m.name)
        .join(', ')})`
    );
  }
  return matches;
}

function testReportByName(
  qUnit: Pick<QUnit, 'config'>,
  mods: PrivateQModInfo[],
  name: string
): PrivateQTestReport[] {
  const allTests = mods
    .map(m => m.suiteReport.tests)
    .reduce((a, ma) => a.concat(ma), []);
  const matches = allTests.filter(t => t.name === name);
  if (matches.length === 0) {
    throw new Error(
      `Test "${name}" mentioned in event, but not found in QUnit module state.\nOnly found (${allTests
        .map(t => t.name)
        .join(', ')})`
    );
  }
  return matches;
}

export function normalizeSuiteStartEvent(
  qUnit: Pick<QUnit, 'config'>,
  evt: QUnit.ModuleStartDetails
): SuiteStartEvent {
  const mods = moduleInfoByName(qUnit, evt.name);
  return {
    event: 'suiteStart',
    data: suiteInfoToSuiteStart(mods[0])
  };
}

export function normalizeSuiteEndEvent(
  qUnit: Pick<QUnit, 'config'>,
  evt: QUnit.ModuleDoneDetails,
  assertions: { [k: string]: QUnit.LogDetails[] | undefined }
): SuiteEndEvent {
  const mods = moduleInfoByName(qUnit, evt.name);
  return {
    event: 'suiteEnd',
    data: suiteInfoToSuiteEnd(mods[0], assertions) // TODO handle duplicate moudle name case
  };
}

export function normalizeTestStartEvent(
  qUnit: Pick<QUnit, 'config'>,
  evt: QUnit.TestStartDetails
): TestStartEvent {
  const mods = moduleInfoByName(qUnit, evt.module);
  const tsts = testReportByName(qUnit, mods, evt.name);
  return {
    event: 'testStart',
    data: testReportToTestStart(mods[0].name, tsts[0])
  };
}

export function normalizeTestEndEvent(
  qUnit: Pick<QUnit, 'config'>,
  evt: QUnit.TestDoneDetails,
  assertions: QUnit.LogDetails[]
): TestEndEvent {
  const mods = moduleInfoByName(qUnit, evt.module);
  const tsts = testReportByName(qUnit, mods, evt.name);
  return {
    event: 'testEnd',
    data: testReportToTestEnd(mods[0].name, tsts[0], assertions) // TODO handle duplicate moudle name case
  };
}

export function normalizeRunStartEvent(
  qUnit: Pick<QUnit, 'config'>,
  evt: QUnit.BeginDetails
): RunStartEvent {
  const childSuites = serializableQunitModules(qUnit).map(
    suiteInfoToSuiteStart
  );
  return {
    event: 'runStart',
    data: {
      fullName: [],
      tests: [],
      childSuites,
      testCounts: {
        total: childSuites.reduce((ct, s) => ct + s.testCounts.total, 0)
      }
    }
  };
}

export function normalizeRunEndEvent(
  qUnit: Pick<QUnit, 'config'>,
  evt: QUnit.DoneDetails,
  assertions: {
    [k: string]: { [k: string]: QUnit.LogDetails[] | undefined } | undefined;
  }
): RunEndEvent {
  const childSuites = serializableQunitModules(qUnit).map(m => {
    const childAsserts: {
      [k: string]: QUnit.LogDetails[] | undefined;
    } = {};
    return suiteInfoToSuiteEnd(m, childAsserts);
  });
  const testCounts = childSuites.reduce(
    (ct, t) => {
      ct.total++;
      switch (t.status) {
        case 'failed':
          ct.failed++;
          break;
        case 'passed':
          ct.passed++;
          break;
        case 'todo':
          ct.todo++;
          break;
        case 'skipped':
          ct.skipped++;
          break;
      }
      return ct;
    },
    {
      total: 0,
      passed: 0,
      skipped: 0,
      todo: 0,
      failed: 0
    }
  );
  return {
    event: 'runEnd',
    data: {
      status: 'passed', // TODO
      fullName: [],
      runtime: childSuites.reduce((ct, s) => ct + s.runtime, 0),
      tests: [],
      childSuites,
      testCounts
    }
  };
}
