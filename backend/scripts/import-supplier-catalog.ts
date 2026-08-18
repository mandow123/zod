import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import { SupplierCatalogImportService } from '../src/resource-inquiries/service.js';
import { PostgresSupplierImportStore } from '../src/resource-inquiries/store.js';

function argumentsFrom(values:string[]){let file:string|undefined,commit=false;for(let index=0;index<values.length;index+=1){
  if(values[index]==='--file')file=values[index+1];if(values[index]==='--commit')commit=true;}
  if(!file)throw new Error('Usage: npm run catalog:import -- --file <private.xlsx> [--commit]');return{file,commit};}

const input=argumentsFrom(process.argv.slice(2)),config=loadConfig(process.env),database=input.commit?createDatabase(config):null;
try{
  const service=new SupplierCatalogImportService(database?new PostgresSupplierImportStore(database):null,config);
  if(input.commit){const result=await service.commit(input.file);process.stdout.write(`${JSON.stringify({mode:'commit',...result})}\n`);}
  else{const{report}=await service.preflight(input.file);process.stdout.write(`${JSON.stringify({mode:'preflight',...report})}\n`);}
}finally{await database?.close();}
