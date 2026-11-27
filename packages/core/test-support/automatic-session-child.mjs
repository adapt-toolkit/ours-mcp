import {prepareAutomaticSession} from '../dist/host-client.js';
const result=await prepareAutomaticSession(JSON.parse(process.env.TEST_SESSION_PROFILE),'codex',process.env.TEST_SESSION_ID,process.env);
console.log(JSON.stringify(result?.identity));
