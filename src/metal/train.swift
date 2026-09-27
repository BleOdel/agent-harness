import Foundation
import Metal

// This fixed recipe has no CPU training path. SGD has no momentum state; weights,
// bias and completed epoch are the entire optimizer checkpoint.
struct Row: Decodable { let id: String; let x: [Double]; let y: Double }
struct Preprocessing: Decodable { let means: [Double]; let scales: [Double] }
struct Training: Decodable { let seed: Int; let epochs: Int; let learningRate: Double }
struct Context: Decodable { let approval: String; let features: [String]; let target: String; let preprocessing: Preprocessing; let training: Training }
struct Input: Decodable { let binding: String; let context: Context; let rows: [Row]; let from: Int; let to: Int; let weights: [Float]; let bias: Float }
struct Params { var rows: UInt32; var features: UInt32; var rate: Float }
func fail(_ message: String) throws -> Never { throw NSError(domain:"HarnessMetal",code:1,userInfo:[NSLocalizedDescriptionKey:message]) }
let shader = """
#include <metal_stdlib>
using namespace metal;
struct Params { uint rows; uint features; float rate; };
kernel void errors(const device float* x [[buffer(0)]], const device float* y [[buffer(1)]], const device float* w [[buffer(2)]], device float* e [[buffer(3)]], constant Params& p [[buffer(4)]], uint row [[thread_position_in_grid]]) {
    if(row>=p.rows)return;
    float predicted=w[p.features];
    for(uint i=0;i<p.features;i++)predicted+=x[row*p.features+i]*w[i];
    e[row]=predicted-y[row];
}
kernel void update(const device float* x [[buffer(0)]], const device float* e [[buffer(1)]], const device float* old [[buffer(2)]], device float* next [[buffer(3)]], constant Params& p [[buffer(4)]], uint feature [[thread_position_in_grid]]) {
    if(feature>p.features)return;
    float gradient=0;
    for(uint row=0;row<p.rows;row++)gradient+=e[row]*(feature==p.features?1.0f:x[row*p.features+feature]);
    next[feature]=old[feature]-p.rate*(2.0f/float(p.rows))*gradient;
}
"""
do {
    guard CommandLine.arguments.count==3 else { try fail("Expected input and output paths") }
    let bytes=try Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))
    let input=try JSONDecoder().decode(Input.self,from:bytes),n=input.rows.count,d=input.context.features.count
    guard n>0,n<=2000,d>0,d<=16,input.from>=0,input.to>input.from,input.to<=input.context.training.epochs,input.weights.count==d else { try fail("Invalid bounded training input") }
    guard let gpu=MTLCreateSystemDefaultDevice(),let queue=gpu.makeCommandQueue() else { try fail("Metal GPU unavailable; CPU fallback refused") }
    let options=MTLCompileOptions();options.fastMathEnabled=false
    let library=try gpu.makeLibrary(source:shader,options:options)
    guard let errors=library.makeFunction(name:"errors"),let update=library.makeFunction(name:"update") else { try fail("Metal kernels missing") }
    let errorPipeline=try gpu.makeComputePipelineState(function:errors),updatePipeline=try gpu.makeComputePipelineState(function:update)
    func buffer(_ values:[Float]) throws -> MTLBuffer { guard let b=values.withUnsafeBytes({gpu.makeBuffer(bytes:$0.baseAddress!,length:$0.count,options:.storageModeShared)}) else { try fail("Metal allocation failed") };return b }
    let x=try buffer(input.rows.flatMap { row in row.x.enumerated().map { i,v in Float((v-input.context.preprocessing.means[i])/input.context.preprocessing.scales[i]) } }),y=try buffer(input.rows.map{Float($0.y)}),e=try buffer(Array(repeating:Float(0),count:n))
    var current=try buffer(input.weights+[input.bias]),next=try buffer(Array(repeating:Float(0),count:d+1)),params=Params(rows:UInt32(n),features:UInt32(d),rate:Float(input.context.training.learningRate))
    var dispatches=0
    for _ in input.from..<input.to {
        guard let command=queue.makeCommandBuffer(),let first=command.makeComputeCommandEncoder() else { try fail("Cannot encode Metal training") }
        first.setComputePipelineState(errorPipeline)
        for (index,b) in [x,y,current,e].enumerated(){first.setBuffer(b,offset:0,index:index)}
        first.setBytes(&params,length:MemoryLayout<Params>.stride,index:4)
        first.dispatchThreads(MTLSize(width:n,height:1,depth:1),threadsPerThreadgroup:MTLSize(width:min(n,errorPipeline.threadExecutionWidth),height:1,depth:1));first.endEncoding()
        guard let second=command.makeComputeCommandEncoder() else { try fail("Cannot encode Metal update") }
        second.setComputePipelineState(updatePipeline)
        for (index,b) in [x,e,current,next].enumerated(){second.setBuffer(b,offset:0,index:index)}
        second.setBytes(&params,length:MemoryLayout<Params>.stride,index:4)
        second.dispatchThreads(MTLSize(width:d+1,height:1,depth:1),threadsPerThreadgroup:MTLSize(width:min(d+1,updatePipeline.threadExecutionWidth),height:1,depth:1));second.endEncoding()
        command.commit();command.waitUntilCompleted()
        guard command.status == .completed,command.error == nil else { try fail("Metal dispatch failed: \(String(describing:command.error))") }
        dispatches+=2;swap(&current,&next)
    }
    let values=Array(UnsafeBufferPointer(start:current.contents().bindMemory(to:Float.self,capacity:d+1),count:d+1))
    guard values.allSatisfy({$0.isFinite}) else { try fail("Training diverged; reduce the learning rate in a new approval") }
    let raw=try JSONSerialization.jsonObject(with:bytes) as! [String:Any]
    var model=raw["context"] as! [String:Any];model["version"]=1;model["kind"]="linear-regression@1";model["completed"]=input.to;model["weights"]=Array(values.prefix(d));model["bias"]=values[d]
    let checkpoint:[String:Any] = ["version":1,"binding":input.binding,"from":input.from,"device":gpu.name,"dispatches":dispatches,"model":model]
    try JSONSerialization.data(withJSONObject:checkpoint,options:[.sortedKeys]).write(to:URL(fileURLWithPath:CommandLine.arguments[2]),options:.atomic)
    print("Metal checkpoint ready")
} catch {
    FileHandle.standardError.write(Data(("Metal training failed: \(error.localizedDescription)\n").utf8));exit(1)
}
