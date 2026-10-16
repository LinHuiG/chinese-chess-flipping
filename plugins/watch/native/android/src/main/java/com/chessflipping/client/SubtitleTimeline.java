package com.chessflipping.client;

import org.json.*;
import java.util.*;

/** Plain-text cues use absolute movie seconds, including after an offset HLS restart. */
final class SubtitleTimeline {
    static final SubtitleTimeline EMPTY=new SubtitleTimeline(Collections.emptyList());
    private static final class Entry {final double start,end;final String text;Entry(double start,double end,String text){this.start=start;this.end=end;this.text=text;}}
    private final List<Entry> entries;private final double[] ending;
    private SubtitleTimeline(List<Entry> entries){this.entries=entries;ending=new double[entries.size()];double end=0;for(int i=0;i<entries.size();i++){end=Math.max(end,entries.get(i).end);ending[i]=end;}}
    static SubtitleTimeline parse(JSONArray values)throws JSONException {
        if(values==null||values.length()==0)return EMPTY;if(values.length()>10000)throw new IllegalArgumentException("Too many subtitle cues");
        List<Entry> entries=new ArrayList<>(values.length());int characters=0;
        for(int i=0;i<values.length();i++){
            JSONObject cue=values.getJSONObject(i);double start=cue.getDouble("start"),end=cue.getDouble("end");String text=cue.getString("text");
            if(!Double.isFinite(start)||!Double.isFinite(end)||start<0||end<=start||text.length()>8192||(characters+=text.length())>2097152)throw new IllegalArgumentException("Invalid subtitle cue");
            if(!text.isEmpty())entries.add(new Entry(start,end,text));
        }
        entries.sort(Comparator.comparingDouble(cue->cue.start));return new SubtitleTimeline(entries);
    }
    List<String> active(double seconds){
        if(!Double.isFinite(seconds)||seconds<0||entries.isEmpty())return Collections.emptyList();
        int low=0,high=ending.length;while(low<high){int middle=(low+high)>>>1;if(ending[middle]<=seconds)low=middle+1;else high=middle;}
        List<String> active=null;for(int i=low;i<entries.size();i++){Entry cue=entries.get(i);if(cue.start>seconds)break;if(cue.end>seconds){if(active==null)active=new ArrayList<>();active.add(cue.text);if(active.size()==8)break;}}
        return active==null?Collections.emptyList():active;
    }
}
