import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

test("export preserves continuous cross-shot B-roll, synchronized text above it, and original audio", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "vf-text-render-"));
  process.env.DATA_DIR = root;
  try {
    const paths = await import("../src/lib/paths"); await paths.ensureDataDirs();
    const { renderRemake } = await import("../src/lib/render-remake");
    const { AnalysisZ } = await import("../src/lib/analysis-schema");
    const { DEFAULT_TEXT_STYLE } = await import("../src/lib/text-overlays-schema");
    const id = "text-render", source = join(paths.EDITING_DIR, `${id}.mp4`);
    const clip = join(paths.LIBRARY_DIR, "roll.mp4");
    await exec("ffmpeg", ["-v","error","-f","lavfi","-i","color=red:size=90x160:rate=30:duration=3","-f","lavfi","-i","sine=frequency=440:duration=3","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest",source]);
    await exec("ffmpeg", ["-v","error","-f","lavfi","-i","color=green:size=90x160:rate=30:duration=1","-f","lavfi","-i","color=blue:size=90x160:rate=30:duration=1","-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0[v]","-map","[v]","-c:v","libx264","-pix_fmt","yuv420p",clip]);
    const analysis = AnalysisZ.parse({ videoId:id, analyzedAt:"2026-01-01",model:"fixture",summary:"",hook_description:"",format:"tutorial",tags:[],music:{title:"",author:"",usage:"original_audio_talking",usage_note:""},full_transcript:"One two.",shots:[0,1.5].map((t,index)=>({index,start_time:t,end_time:t+1.5,source_start:t,source_end:t+1.5,description:"Source",on_screen_text:"",spoken_text:index===0?"One two.":"",camera_style:"static",screenshot:""})) });
    const manifest = await renderRemake({ videoId:id,analysis,sourceVideo:`${id}.mp4`,library:{videos:[],lastUpdated:""},editNotes:{},audio:"original",burnText:true,
      recs:{videoId:id,generatedAt:"2026-01-01",model:"fixture",clipsConsidered:0,shots:analysis.shots.map(s=>({shot_index:s.index,keep_source:true,selected_filename:null,recommendations:[]}))},
      sourceShots:analysis.shots.map(s=>({path:source,filename:`${id}.mp4`,start:s.start_time,end:s.end_time})),
      broll:[{id:"span",filename:"roll.mp4",start:.5,end:2.5,clip_start:0,phrase:""}],
      textOverlays:{videoId:id,updatedAt:"",style:{...DEFAULT_TEXT_STYLE,color:"#00ffff"},shots:{"0":{text:"kept custom",include:true,matchSpeech:true,words:[{text:"One",start:.2,end:.7},{text:"two.",start:.8,end:1.4}]}}},
    });
    assert(!manifest.warnings.some(w=>/failed/i.test(w)),manifest.warnings.join("\n"));
    assert.equal(manifest.text_burn?.engine,"png");assert.equal(manifest.broll?.length,1);
    assert.equal(manifest.shots[0].burned_text,"One two.");
    const output = join(paths.RENDERS_DIR,`${id}.mp4`);
    const sample = async (time:number, filter="crop=100:100:490:1000,scale=1:1") => {
      const result=await exec("ffmpeg",["-v","error","-ss",String(time),"-i",output,"-vf",filter,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],{encoding:"buffer",maxBuffer:10*1024*1024});return result.stdout;
    };
    const red=await sample(.1),green=await sample(.9),blue=await sample(1.9),redAgain=await sample(2.8);
    assert(red[0]>red[1]+80);assert(green[1]>green[0]+60);assert(blue[2]>blue[1]+80,"B-roll must continue into its blue second half across the main-video cut");assert(redAgain[0]>redAgain[1]+80);
    const caption=await sample(.9,"crop=900:200:90:240");
    let cyan=0;for(let i=0;i<caption.length;i+=3)if(caption[i]<100&&caption[i+1]>150&&caption[i+2]>150)cyan++;
    assert(cyan>50,"Caption must appear above the green B-roll");
    const {stdout}=await exec("ffprobe",["-v","error","-select_streams","a","-show_entries","stream=codec_type","-of","csv=p=0",output]);assert.match(stdout,/audio/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
