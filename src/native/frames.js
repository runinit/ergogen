const RAD = Math.PI / 180
const identity = () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
const multiply = (a,b) => Array.from({length:16}, (_,i) => {
    const row = Math.floor(i/4), col = i%4
    return [0,1,2,3].reduce((sum,k) => sum+a[row*4+k]*b[k*4+col],0)
})
const transform = (matrix, point) => [0,1,2].map(row => matrix[row*4+3]+[0,1,2].reduce((sum,col) => sum+matrix[row*4+col]*(point[col] || 0),0))
const local = (at = [0,0,0], yaw = 0, tilt = 0) => {
    const c=Math.cos(yaw*RAD), s=Math.sin(yaw*RAD), x=Math.cos(tilt*RAD), y=Math.sin(tilt*RAD)
    return [c,-s*x,s*y,at[0], s,c*x,-c*y,at[1], 0,y,x,at[2], 0,0,0,1]
}
const inverse = matrix => {
    const out=identity()
    for (let row=0;row<3;row++) {
        for (let col=0;col<3;col++) { out[row*4+col]=matrix[col*4+row] }
        out[row*4+3]=-[0,1,2].reduce((sum,col)=>sum+out[row*4+col]*matrix[col*4+3],0)
    }
    return out
}
const position = matrix => transform(matrix,[0,0,0])
const yaw = matrix => Math.atan2(matrix[4],matrix[0])/RAD
module.exports = {identity,multiply,transform,local,inverse,position,yaw,RAD}
