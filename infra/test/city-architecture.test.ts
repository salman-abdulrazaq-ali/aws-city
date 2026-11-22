// My AWS → How AWS City runs (shared/city-architecture.json) shows the city's own parts and the only prices it can stand
// behind: Fargate's, from the task sizes and the Price List figure. These checks keep that file honest against the
// stacks the city really deploys, so a change to a task size or a price can't leave the drawing saying something else.
import { existsSync, readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import arch from '../../shared/city-architecture.json' with { type: 'json' };
import { AuthStack } from '../lib/auth-stack.js';
import type { EnvConfig } from '../lib/config.js';
import { DataStack } from '../lib/data-stack.js';
import { CPU_MODEL, cpuAiHourly, FARGATE_ARM_PRICE, modelsForChoice } from '../lib/models.js';
import { ServiceStack } from '../lib/service-stack.js';

const env: EnvConfig = {
  name: 'prod', region: 'eu-west-2', domainName: '', hostedZoneId: '', zoneName: '',
  cognitoDomainPrefix: 'cloud-city-test', extensionIds: ['abcdefghijklmnopabcdefghijklmnop'], googleClientId: '',
  sesFromEmail: '', alarmEmail: 'ops@example.com', monthlyBudgetUsd: 100, dailyModelCalls: 100, globalDailyModelCalls: 20000,
  minTasks: 2, maxTasks: 10, aiCpu: { spot: false, primary: true }, modelChoice: 'nova', models: modelsForChoice('eu-west-2', 'nova'),
};

const synth = () => {
  const app = new App();
  const where = { env: { account: '111122223333', region: env.region } };
  const data = new DataStack(app, 'D', env, where);
  const auth = new AuthStack(app, 'A', env, { ...where, authRelayUrl: data.authRelayUrl });
  const svc = new ServiceStack(app, 'S', env, { table: data.table, screenshots: data.screenshots, playerRoleTemplateUrl: data.playerRoleTemplateUrl, userPool: auth.userPool, client: auth.client }, where);
  return Template.fromStack(svc);
};

const component = (id: string) => arch.components.find((c) => c.id === id)!;
type Size = { cpu: number; memoryMiB: number; tasks: number };
const hourly = (f: Size) => f.tasks * ((f.cpu / 1024) * arch.price.vcpuHour + (f.memoryMiB / 1024) * arch.price.gbHour);

describe('How AWS City runs: the drawing matches what the city deploys', () => {
  const svc = synth();
  const taskDefs = Object.values(svc.findResources('AWS::ECS::TaskDefinition')) as { Properties: { Cpu: string; Memory: string } }[];
  const sizes = taskDefs.map((t) => `${t.Properties.Cpu}/${t.Properties.Memory}`);

  it('the server and the AI service have the task sizes the drawing prices', () => {
    const server = component('server').fargate as Size;
    const ai = component('ai').fargate as Size;
    expect(sizes).toContain(`${server.cpu}/${server.memoryMiB}`);
    expect(sizes).toContain(`${ai.cpu}/${ai.memoryMiB}`);
    expect(ai).toMatchObject({ cpu: CPU_MODEL.cpu, memoryMiB: CPU_MODEL.memoryMiB, tasks: 1 });
  });

  it('two servers is prod’s published minimum (cdk.json), and the price is the Price List figure models.ts uses', () => {
    const cdk = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as { context: { prod: { minTasks: number } } };
    expect((component('server').fargate as Size).tasks).toBe(cdk.context.prod.minTasks);
    expect({ region: arch.price.region, vcpuHour: arch.price.vcpuHour, gbHour: arch.price.gbHour }).toEqual({ ...FARGATE_ARM_PRICE });
    expect(hourly(component('ai').fargate as Size)).toBeCloseTo(cpuAiHourly(), 9);
  });

  it('the idle estimate is the README’s, and every stack it names exists', () => {
    expect(readFileSync(new URL('../../README.md', import.meta.url), 'utf8')).toContain(`$${arch.idle.low}–${arch.idle.high}`);
    for (const c of arch.components) if ('stack' in c && c.stack) expect(existsSync(new URL(`../lib/${c.stack}`, import.meta.url)), c.stack).toBe(true);
  });
});
