import {jobRecipe as linearRecipe} from '../ml/recipe.ts';
import {torchRecipe} from '../torch/recipe.ts';
import type {JobSpec,Checkpoint} from './schema.ts';
/** Dispatch without changing existing linear-regression recipe hashes. */
export async function jobRecipe(project:string,spec:JobSpec){return spec.recipe?.id==='torch-cpu'?torchRecipe(project,spec):linearRecipe(project,spec);}
export async function validateJobCheckpoint(project:string,spec:JobSpec,point:Checkpoint){(await jobRecipe(project,spec))?.validate(point);}
