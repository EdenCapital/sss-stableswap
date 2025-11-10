import React from 'react'
export default function AmountInput({value,onChange}:{value:string;onChange:(v:string)=>void}){
  return <input value={value} onChange={e=>onChange(e.target.value)} placeholder="输入数量（自然数，内部 e6）" style={{padding:8,width:240}}/>
}
