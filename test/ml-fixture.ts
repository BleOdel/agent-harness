export const csv = (count=100) => 'id,x,target\n'+Array.from({length:count},(_,i)=>`row${i},${i/count},${3+2*i/count}`).join('\n')+'\n';
export const spec = {version:1,title:'Predict a numeric target',target:'target',seed:42,epochs:200,learningRate:0.05,maxRmse:0.01,minImprovement:0.9,limits:{timeoutSeconds:60,totalSeconds:180,maxAttempts:3}};
